//! HTN Market — an on-chain LMSR prediction market.
//!
//! Prices are computed by this program, not by any server. Collateral sits in
//! a vault owned by the market PDA, so nobody (including the market creator)
//! can withdraw it except through the rules below. Outcome shares are SPL
//! mints whose only mint authority is the market PDA.
//!
//! Trust model, stated plainly: the market `authority` is an oracle. It may
//! call `Resolve` exactly once to report the winner. It cannot move funds,
//! mint shares, or change prices.
//!
//! Instructions (first data byte):
//!   0 CreateMarket { market_id: u64, n: u8, b_units: u64 }
//!   1 Buy          { outcome: u8, spend: u64, min_shares: u64 }
//!   2 Sell         { outcome: u8, shares: u64, min_refund: u64 }
//!   3 Resolve      { winner: u8 }
//!   4 Redeem       {}

pub mod math;
pub mod state;

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use state::{Market, LEN, MAX_OUTCOMES, STATUS_OPEN, STATUS_RESOLVED};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_ACCOUNT_LEN: u64 = 165;
const MINT_LEN: u64 = 82;
const DECIMALS: u8 = 6;

#[repr(u32)]
enum MarketError {
    NotOpen = 1,
    NotResolved,
    BadOutcome,
    Slippage,
    BadPda,
    NotAuthority,
    ZeroAmount,
    WrongMint,
    Insolvent,
}
impl From<MarketError> for ProgramError {
    fn from(e: MarketError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

// ------------------------------------------------------------------ helpers

fn read_u64(d: &[u8], o: usize) -> Result<u64, ProgramError> {
    d.get(o..o + 8)
        .map(|s| u64::from_le_bytes(s.try_into().unwrap()))
        .ok_or(ProgramError::InvalidInstructionData)
}

fn market_seeds<'a>(authority: &'a Pubkey, id: &'a [u8; 8]) -> [&'a [u8]; 3] {
    [b"market", authority.as_ref(), id.as_ref()]
}

fn expect_key(got: &Pubkey, want: &Pubkey) -> ProgramResult {
    if got != want {
        return Err(MarketError::BadPda.into());
    }
    Ok(())
}

// SPL Token instructions, hand-encoded. Layouts from the SPL Token program:
//   Transfer        tag 3  [amount u64]            [source, dest, authority]
//   MintTo          tag 7  [amount u64]            [mint, dest, authority]
//   Burn            tag 8  [amount u64]            [account, mint, authority]
//   InitAccount3    tag 18 [owner 32]              [account, mint]
//   InitMint2       tag 20 [dec, auth 32, freeze COption=0] [mint]
fn tok(tag: u8, payload: &[u8], metas: Vec<AccountMeta>) -> Instruction {
    let mut data = Vec::with_capacity(1 + payload.len());
    data.push(tag);
    data.extend_from_slice(payload);
    Instruction { program_id: TOKEN_PROGRAM_ID, accounts: metas, data }
}

fn ix_transfer(src: &Pubkey, dst: &Pubkey, auth: &Pubkey, amount: u64) -> Instruction {
    tok(3, &amount.to_le_bytes(), vec![
        AccountMeta::new(*src, false),
        AccountMeta::new(*dst, false),
        AccountMeta::new_readonly(*auth, true),
    ])
}

fn ix_mint_to(mint: &Pubkey, dst: &Pubkey, auth: &Pubkey, amount: u64) -> Instruction {
    tok(7, &amount.to_le_bytes(), vec![
        AccountMeta::new(*mint, false),
        AccountMeta::new(*dst, false),
        AccountMeta::new_readonly(*auth, true),
    ])
}

fn ix_burn(acct: &Pubkey, mint: &Pubkey, auth: &Pubkey, amount: u64) -> Instruction {
    tok(8, &amount.to_le_bytes(), vec![
        AccountMeta::new(*acct, false),
        AccountMeta::new(*mint, false),
        AccountMeta::new_readonly(*auth, true),
    ])
}

fn ix_init_account3(acct: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    tok(18, owner.as_ref(), vec![
        AccountMeta::new(*acct, false),
        AccountMeta::new_readonly(*mint, false),
    ])
}

fn ix_init_mint2(mint: &Pubkey, authority: &Pubkey) -> Instruction {
    let mut p = Vec::with_capacity(34);
    p.push(DECIMALS);
    p.extend_from_slice(authority.as_ref());
    p.push(0); // freeze authority: None
    tok(20, &p, vec![AccountMeta::new(*mint, false)])
}

/// Parse (mint, owner, amount) from a raw SPL token account.
fn token_account(ai: &AccountInfo) -> Result<(Pubkey, Pubkey, u64), ProgramError> {
    if ai.owner != &TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mint = Pubkey::new_from_array(d[0..32].try_into().unwrap());
    let owner = Pubkey::new_from_array(d[32..64].try_into().unwrap());
    Ok((mint, owner, read_u64(&d, 64)?))
}

/// Load a market and verify it is this program's genuine market PDA.
fn load_market(program_id: &Pubkey, ai: &AccountInfo) -> Result<Market, ProgramError> {
    if ai.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let m = Market::unpack(&ai.try_borrow_data()?)?;
    let id = m.market_id.to_le_bytes();
    let s = market_seeds(&m.authority, &id);
    let expected =
        Pubkey::create_program_address(&[s[0], s[1], s[2], &[m.bump]], program_id)?;
    expect_key(ai.key, &expected)?;
    Ok(m)
}

fn check_vault(program_id: &Pubkey, market: &Pubkey, m: &Market, vault: &AccountInfo) -> ProgramResult {
    let want = Pubkey::create_program_address(&[b"vault", market.as_ref(), &[m.vault_bump]], program_id)?;
    expect_key(vault.key, &want)
}

fn check_outcome_mint(program_id: &Pubkey, market: &Pubkey, m: &Market, i: usize, mint: &AccountInfo) -> ProgramResult {
    let want = Pubkey::create_program_address(
        &[b"outcome", market.as_ref(), &[i as u8], &[m.mint_bumps[i]]],
        program_id,
    )?;
    expect_key(mint.key, &want)
}

fn check_token_program(ai: &AccountInfo) -> ProgramResult {
    if ai.key != &TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

// --------------------------------------------------------------- entrypoint

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => create_market(program_id, accounts, data),
        Some(1) => buy(program_id, accounts, data),
        Some(2) => sell(program_id, accounts, data),
        Some(3) => resolve(program_id, accounts, data),
        Some(4) => redeem(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Accounts: authority(s,w) market(w) vault(w) collateral_mint
///           authority_collateral(w) token_program system_program
///           outcome_mint_0..n(w)
fn create_market(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let market_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let collateral_mint = next_account_info(it)?;
    let authority_collateral = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    check_token_program(token_program)?;
    if system.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let market_id = read_u64(data, 1)?;
    let n = *data.get(9).ok_or(ProgramError::InvalidInstructionData)? as usize;
    let b_units = read_u64(data, 10)?;
    if !(2..=MAX_OUTCOMES).contains(&n) || b_units == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let id = market_id.to_le_bytes();
    let s = market_seeds(authority.key, &id);
    let (market_key, bump) = Pubkey::find_program_address(&s, program_id);
    expect_key(market_ai.key, &market_key)?;
    let (vault_key, vault_bump) =
        Pubkey::find_program_address(&[b"vault", market_key.as_ref()], program_id);
    expect_key(vault.key, &vault_key)?;

    let rent = Rent::get()?;
    let market_signer: &[&[u8]] = &[s[0], s[1], s[2], &[bump]];

    // 1. Market state account, owned by this program.
    invoke_signed(
        &system_instruction::create_account(
            authority.key, &market_key, rent.minimum_balance(LEN), LEN as u64, program_id),
        &[authority.clone(), market_ai.clone(), system.clone()],
        &[market_signer],
    )?;

    // 2. Collateral vault: an SPL token account whose owner is the market PDA.
    invoke_signed(
        &system_instruction::create_account(
            authority.key, &vault_key, rent.minimum_balance(TOKEN_ACCOUNT_LEN as usize),
            TOKEN_ACCOUNT_LEN, &TOKEN_PROGRAM_ID),
        &[authority.clone(), vault.clone(), system.clone()],
        &[&[b"vault", market_key.as_ref(), &[vault_bump]]],
    )?;
    invoke(
        &ix_init_account3(&vault_key, collateral_mint.key, &market_key),
        &[vault.clone(), collateral_mint.clone(), token_program.clone()],
    )?;

    // 3. One SPL mint per outcome. Only the market PDA can mint shares.
    let mut mint_bumps = [0u8; MAX_OUTCOMES];
    for (i, bump_slot) in mint_bumps.iter_mut().enumerate().take(n) {
        let mint_ai = next_account_info(it)?;
        let (mint_key, mb) = Pubkey::find_program_address(
            &[b"outcome", market_key.as_ref(), &[i as u8]], program_id);
        expect_key(mint_ai.key, &mint_key)?;
        *bump_slot = mb;
        invoke_signed(
            &system_instruction::create_account(
                authority.key, &mint_key, rent.minimum_balance(MINT_LEN as usize),
                MINT_LEN, &TOKEN_PROGRAM_ID),
            &[authority.clone(), mint_ai.clone(), system.clone()],
            &[&[b"outcome", market_key.as_ref(), &[i as u8], &[mb]]],
        )?;
        invoke(&ix_init_mint2(&mint_key, &market_key), &[mint_ai.clone(), token_program.clone()])?;
    }

    // 4. Solvency is enforced, not trusted: the creator must deposit LMSR's
    //    worst-case loss b*ln(n) into the vault up front.
    let b = b_units as f64 / math::UNIT;
    let subsidy = math::required_subsidy(b, n);
    invoke(
        &ix_transfer(authority_collateral.key, &vault_key, authority.key, subsidy),
        &[authority_collateral.clone(), vault.clone(), authority.clone(), token_program.clone()],
    )?;

    let m = Market {
        bump, vault_bump, n: n as u8, status: STATUS_OPEN, winner: 0,
        authority: *authority.key, collateral_mint: *collateral_mint.key,
        market_id, b_units, q: [0; MAX_OUTCOMES], mint_bumps,
    };
    m.pack(&mut market_ai.try_borrow_mut_data()?)?;
    msg!("market {} created: n={} b={} subsidy={}", market_id, n, b_units, subsidy);
    Ok(())
}

/// Accounts: user(s) market(w) vault(w) user_collateral(w)
///           outcome_mint(w) user_outcome(w) token_program
fn buy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let market_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let user_collateral = next_account_info(it)?;
    let outcome_mint = next_account_info(it)?;
    let user_outcome = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    check_token_program(token_program)?;
    let outcome = *data.get(1).ok_or(ProgramError::InvalidInstructionData)? as usize;
    let spend = read_u64(data, 2)?;
    let min_shares = read_u64(data, 10)?;
    if spend == 0 {
        return Err(MarketError::ZeroAmount.into());
    }

    let mut m = load_market(program_id, market_ai)?;
    if m.status != STATUS_OPEN {
        return Err(MarketError::NotOpen.into());
    }
    if outcome >= m.n as usize {
        return Err(MarketError::BadOutcome.into());
    }
    check_vault(program_id, market_ai.key, &m, vault)?;
    check_outcome_mint(program_id, market_ai.key, &m, outcome, outcome_mint)?;

    // The price is decided HERE, on-chain.
    let shares = math::shares_for_budget(m.active_q(), m.b(), outcome, spend);
    if shares == 0 {
        return Err(MarketError::ZeroAmount.into());
    }
    if shares < min_shares {
        return Err(MarketError::Slippage.into());
    }

    // Collateral in (user signs). The token program rejects a mint mismatch.
    invoke(
        &ix_transfer(user_collateral.key, vault.key, user.key, spend),
        &[user_collateral.clone(), vault.clone(), user.clone(), token_program.clone()],
    )?;
    // Shares out (only the market PDA can sign this).
    let id = m.market_id.to_le_bytes();
    let s = market_seeds(&m.authority, &id);
    invoke_signed(
        &ix_mint_to(outcome_mint.key, user_outcome.key, market_ai.key, shares),
        &[outcome_mint.clone(), user_outcome.clone(), market_ai.clone(), token_program.clone()],
        &[&[s[0], s[1], s[2], &[m.bump]]],
    )?;

    m.q[outcome] = m.q[outcome].checked_add(shares).ok_or(ProgramError::ArithmeticOverflow)?;
    m.pack(&mut market_ai.try_borrow_mut_data()?)?;
    msg!("buy outcome={} spend={} shares={}", outcome, spend, shares);
    Ok(())
}

/// Accounts: user(s) market(w) vault(w) user_collateral(w)
///           outcome_mint(w) user_outcome(w) token_program
fn sell(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let market_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let user_collateral = next_account_info(it)?;
    let outcome_mint = next_account_info(it)?;
    let user_outcome = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    check_token_program(token_program)?;
    let outcome = *data.get(1).ok_or(ProgramError::InvalidInstructionData)? as usize;
    let shares = read_u64(data, 2)?;
    let min_refund = read_u64(data, 10)?;
    if shares == 0 {
        return Err(MarketError::ZeroAmount.into());
    }

    let mut m = load_market(program_id, market_ai)?;
    if m.status != STATUS_OPEN {
        return Err(MarketError::NotOpen.into());
    }
    if outcome >= m.n as usize || shares > m.q[outcome] {
        return Err(MarketError::BadOutcome.into());
    }
    check_vault(program_id, market_ai.key, &m, vault)?;
    check_outcome_mint(program_id, market_ai.key, &m, outcome, outcome_mint)?;

    let refund = math::sell_refund(m.active_q(), m.b(), outcome, shares);
    if refund < min_refund {
        return Err(MarketError::Slippage.into());
    }

    // Burn fails inside the token program if the user doesn't hold them.
    invoke(
        &ix_burn(user_outcome.key, outcome_mint.key, user.key, shares),
        &[user_outcome.clone(), outcome_mint.clone(), user.clone(), token_program.clone()],
    )?;
    let id = m.market_id.to_le_bytes();
    let s = market_seeds(&m.authority, &id);
    invoke_signed(
        &ix_transfer(vault.key, user_collateral.key, market_ai.key, refund),
        &[vault.clone(), user_collateral.clone(), market_ai.clone(), token_program.clone()],
        &[&[s[0], s[1], s[2], &[m.bump]]],
    )?;

    m.q[outcome] -= shares;
    m.pack(&mut market_ai.try_borrow_mut_data()?)?;
    msg!("sell outcome={} shares={} refund={}", outcome, shares, refund);
    Ok(())
}

/// Accounts: authority(s) market(w)
fn resolve(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let market_ai = next_account_info(it)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut m = load_market(program_id, market_ai)?;
    if authority.key != &m.authority {
        return Err(MarketError::NotAuthority.into());
    }
    if m.status != STATUS_OPEN {
        return Err(MarketError::NotOpen.into()); // can only resolve once
    }
    let winner = *data.get(1).ok_or(ProgramError::InvalidInstructionData)?;
    if winner as usize >= m.n as usize {
        return Err(MarketError::BadOutcome.into());
    }
    m.status = STATUS_RESOLVED;
    m.winner = winner;
    m.pack(&mut market_ai.try_borrow_mut_data()?)?;
    msg!("market {} resolved: winner={}", m.market_id, winner);
    Ok(())
}

/// Accounts: user(s) market vault(w) user_collateral(w)
///           winning_mint(w) user_outcome(w) token_program
fn redeem(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let market_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let user_collateral = next_account_info(it)?;
    let winning_mint = next_account_info(it)?;
    let user_outcome = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    check_token_program(token_program)?;
    let m = load_market(program_id, market_ai)?;
    if m.status != STATUS_RESOLVED {
        return Err(MarketError::NotResolved.into());
    }
    check_vault(program_id, market_ai.key, &m, vault)?;
    check_outcome_mint(program_id, market_ai.key, &m, m.winner as usize, winning_mint)?;

    let (mint, owner, amount) = token_account(user_outcome)?;
    if mint != *winning_mint.key || owner != *user.key {
        return Err(MarketError::WrongMint.into());
    }
    if amount == 0 {
        return Err(MarketError::ZeroAmount.into());
    }
    let (_, _, vault_bal) = token_account(vault)?;
    if vault_bal < amount {
        return Err(MarketError::Insolvent.into()); // should be unreachable
    }

    invoke(
        &ix_burn(user_outcome.key, winning_mint.key, user.key, amount),
        &[user_outcome.clone(), winning_mint.clone(), user.clone(), token_program.clone()],
    )?;
    // Winning shares pay 1:1 (same 6 decimals as the collateral).
    let id = m.market_id.to_le_bytes();
    let s = market_seeds(&m.authority, &id);
    invoke_signed(
        &ix_transfer(vault.key, user_collateral.key, market_ai.key, amount),
        &[vault.clone(), user_collateral.clone(), market_ai.clone(), token_program.clone()],
        &[&[s[0], s[1], s[2], &[m.bump]]],
    )?;
    msg!("redeemed {} winning shares", amount);
    Ok(())
}
