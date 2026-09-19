//! Market account layout. Hand-packed, fixed size, no serialization crate.
//!
//! offset  size  field
//!   0      1    version
//!   1      1    market PDA bump
//!   2      1    vault PDA bump
//!   3      1    n (number of outcomes)
//!   4      1    status (0 = open, 1 = resolved)
//!   5      1    winner (valid when resolved)
//!   6      2    padding
//!   8     32    authority (the resolver; cannot touch funds or prices)
//!  40     32    collateral mint (HACK)
//!  72      8    market id (PDA seed)
//!  80      8    b, in base units
//!  88     64    q[8], outstanding shares per outcome, base units
//! 152      8    outcome mint PDA bumps

use solana_program::{program_error::ProgramError, pubkey::Pubkey};

pub const MAX_OUTCOMES: usize = 8;
pub const LEN: usize = 160;
pub const VERSION: u8 = 1;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_RESOLVED: u8 = 1;

pub struct Market {
    pub bump: u8,
    pub vault_bump: u8,
    pub n: u8,
    pub status: u8,
    pub winner: u8,
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub market_id: u64,
    pub b_units: u64,
    pub q: [u64; MAX_OUTCOMES],
    pub mint_bumps: [u8; MAX_OUTCOMES],
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

impl Market {
    pub fn b(&self) -> f64 {
        self.b_units as f64 / crate::math::UNIT
    }

    pub fn active_q(&self) -> &[u64] {
        &self.q[..self.n as usize]
    }

    pub fn unpack(d: &[u8]) -> Result<Self, ProgramError> {
        if d.len() < LEN || d[0] != VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut q = [0u64; MAX_OUTCOMES];
        for (i, slot) in q.iter_mut().enumerate() {
            *slot = u64_at(d, 88 + 8 * i);
        }
        let mut mint_bumps = [0u8; MAX_OUTCOMES];
        mint_bumps.copy_from_slice(&d[152..160]);
        Ok(Self {
            bump: d[1],
            vault_bump: d[2],
            n: d[3],
            status: d[4],
            winner: d[5],
            authority: Pubkey::new_from_array(d[8..40].try_into().unwrap()),
            collateral_mint: Pubkey::new_from_array(d[40..72].try_into().unwrap()),
            market_id: u64_at(d, 72),
            b_units: u64_at(d, 80),
            q,
            mint_bumps,
        })
    }

    pub fn pack(&self, d: &mut [u8]) -> Result<(), ProgramError> {
        if d.len() < LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        d[0] = VERSION;
        d[1] = self.bump;
        d[2] = self.vault_bump;
        d[3] = self.n;
        d[4] = self.status;
        d[5] = self.winner;
        d[6] = 0;
        d[7] = 0;
        d[8..40].copy_from_slice(self.authority.as_ref());
        d[40..72].copy_from_slice(self.collateral_mint.as_ref());
        d[72..80].copy_from_slice(&self.market_id.to_le_bytes());
        d[80..88].copy_from_slice(&self.b_units.to_le_bytes());
        for i in 0..MAX_OUTCOMES {
            d[88 + 8 * i..96 + 8 * i].copy_from_slice(&self.q[i].to_le_bytes());
        }
        d[152..160].copy_from_slice(&self.mint_bumps);
        Ok(())
    }
}
