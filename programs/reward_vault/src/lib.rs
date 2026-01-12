use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

const DEFAULT_PROGRAM_ID: &str = "eD97PpKEcqEWZtZJKttwc6RfDkowcybP4mJskPn1uqf";
const PROGRAM_ID_STR: &str = match option_env!("REWARD_VAULT_PROGRAM_ID") {
    Some(val) => val,
    None => DEFAULT_PROGRAM_ID,
};
const PROGRAM_ID: Pubkey = Pubkey::from_str_const(PROGRAM_ID_STR);

declare_id!(PROGRAM_ID);

// Constants
const BPS_DENOMINATOR: u128 = 10_000; // 100% = 10000 bps
const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const WSOL_SCALE_U128: u128 = 1_000_000_000; // WSOL has 9 decimals
const MIN_POP_SOFT_DAILY_CAP_USD_E6: u64 = 1_000_000; // $1.00 minimum
const MAX_POP_SOFT_COOLDOWN_SECS: u64 = 86_400; // 24h maximum
const MIN_POP_MONTHLY_CLAIM_LIMIT: u16 = 1;
const MAX_POP_MONTHLY_CLAIM_LIMIT: u16 = 31;
const MIN_POP_HARD_KYC_THRESHOLD_USD_E6: u64 = 1_000_000; // $1.00 minimum
const DEFAULT_PYTH_MAX_CONFIDENCE_BPS: u16 = 100; // 1% max confidence interval

fn wsol_mint() -> Pubkey { WSOL_MINT }

fn month_index_from_ts(ts: i64) -> i64 {
    let days = ts.div_euclid(86_400);
    let (year, month) = year_month_from_days(days);
    (year as i64) * 12 + (month as i64 - 1)
}

fn year_month_from_days(days: i64) -> (i32, u32) {
    // Civil-from-days algorithm (UTC) to compute year/month.
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let m = (mp + if mp < 10 { 3 } else { -9 }) as i32; // [1, 12]
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32)
}

fn pow10_u128(p: u32) -> Option<u128> {
    let mut v: u128 = 1;
    for _ in 0..p { v = v.checked_mul(10)?; }
    Some(v)
}

fn scale_price_to_e6(price: i64, expo: i32) -> Option<u64> {
    // Convert price * 10^expo to micro-units (1e-6). Handles negative expo safely.
    let mut val: i128 = price as i128;
    let adj = expo + 6; // target expo is -6
    if adj >= 0 {
        let p = adj as u32;
        let f = pow10_u128(p)? as i128;
        val = val.checked_mul(f)?;
    } else {
        let p = (-adj) as u32;
        let f = pow10_u128(p)? as i128;
        // floor toward zero
        val = val.checked_div(f)?;
    }
    if val < 0 { None } else { u64::try_from(val).ok() }
}

fn resolve_forca_usd_e6(
    st: &VaultState,
    now: i64,
    pyth_ai: &AccountInfo,
    pool_ai: &AccountInfo,
    pool_forca_reserve_key: Pubkey,
    pool_sol_reserve_key: Pubkey,
    pool_forca_reserve: &TokenAccount,
    pool_sol_reserve: &TokenAccount,
) -> Result<u64> {
    if st.verify_prices && !st.use_mock_oracle {
        require_keys_eq!(pyth_ai.key(), st.pyth_sol_usd_price_feed, RvError::OracleKeyMismatch);
        require_keys_eq!(pool_ai.key(), st.canonical_pool_forca_sol, RvError::OracleKeyMismatch);
        require_keys_eq!(pool_forca_reserve_key, st.canonical_pool_forca_reserve, RvError::OracleKeyMismatch);
        require_keys_eq!(pool_sol_reserve_key, st.canonical_pool_sol_reserve, RvError::OracleKeyMismatch);
        require_keys_eq!(pool_forca_reserve.mint, st.forca_mint, RvError::InvalidMint);
        require_keys_eq!(pool_sol_reserve.mint, wsol_mint(), RvError::InvalidMint);
        require_keys_eq!(pool_forca_reserve.owner, st.canonical_pool_forca_sol, RvError::OracleKeyMismatch);
        require_keys_eq!(pool_sol_reserve.owner, st.canonical_pool_forca_sol, RvError::OracleKeyMismatch);

        let data = pyth_ai.try_borrow_data()?;
        let owner = pyth_ai.owner;
        require!(*owner == push_oracle_program_id() || *owner == receiver_program_id(), RvError::OracleParseFailed);
        let (px, expo, conf_e8, pub_ts) = parse_anchor_price_message(&data)
            .ok_or(RvError::OracleParseFailed)?;
        require!(pub_ts <= now, RvError::OracleParseFailed);
        let age = now.checked_sub(pub_ts).ok_or(RvError::Overflow)? as u64;
        require!(age <= st.pyth_max_stale_secs, RvError::OracleStale);
        if st.pyth_max_confidence_bps > 0 {
            let conf_bps = conf_bps_from_price(px, conf_e8).ok_or(RvError::OracleParseFailed)?;
            require!(conf_bps <= st.pyth_max_confidence_bps as u128, RvError::OracleConfidenceTooWide);
        }
        let sol_usd_e6 = scale_price_to_e6(px, expo).ok_or(RvError::OracleParseFailed)?;
        require!(sol_usd_e6 > 0, RvError::OracleParseFailed);

        let rf = pool_forca_reserve.amount as u128; // FORCA 1e6
        let rs = pool_sol_reserve.amount as u128;   // SOL 1e9
        require!(rs > 0, RvError::OracleParseFailed);
        let derived_forca_per_sol = rf
            .checked_mul(WSOL_SCALE_U128)
            .ok_or(RvError::Overflow)?
            .checked_div(rs)
            .ok_or(RvError::Overflow)?;
        require!(derived_forca_per_sol > 0, RvError::OracleParseFailed);

        let forca_usd_u128 = (sol_usd_e6 as u128)
            .checked_mul(1_000_000u128)
            .ok_or(RvError::Overflow)?
            .checked_div(derived_forca_per_sol)
            .ok_or(RvError::Overflow)?;
        require!(forca_usd_u128 > 0, RvError::OracleParseFailed);
        Ok(u64::try_from(forca_usd_u128).map_err(|_| RvError::Overflow)?)
    } else {
        Ok(st.forca_usd_e6)
    }
}

fn within_bps(value: u64, reference: u64, tol_bps: u16) -> bool {
    if reference == 0 { return false; }
    let v = value as i128;
    let r = reference as i128;
    let diff = (v - r).abs() as i128;
    let limit = (r * (tol_bps as i128)) / (BPS_DENOMINATOR as i128);
    diff <= limit
}

fn conf_bps_from_price(price: i64, conf: u64) -> Option<u128> {
    let price_i128 = price as i128;
    if price_i128 == 0 { return None; }
    let price_abs = price_i128.abs() as u128;
    let conf_u128 = conf as u128;
    conf_u128
        .checked_mul(BPS_DENOMINATOR)?
        .checked_div(price_abs)
}

fn benefit_mode_from_u8(v: u8) -> Result<BenefitMode> {
    match v {
        0 => Ok(BenefitMode::None),
        1 => Ok(BenefitMode::Discount),
        2 => Ok(BenefitMode::BonusPP),
        _ => err!(RvError::InvalidBenefitMode),
    }
}

fn pause_reason_from_u16(v: u16) -> Result<PauseReason> {
    match v {
        0 => Ok(PauseReason::None),
        1 => Ok(PauseReason::NonPayment),
        2 => Ok(PauseReason::SecurityIncident),
        3 => Ok(PauseReason::ComplianceHold),
        4 => Ok(PauseReason::MarketAnomaly),
        5 => Ok(PauseReason::OpsMaintenance),
        _ => err!(RvError::InvalidPauseReason),
    }
}


// Pyth Push Oracle / Receiver anchor account layout parser (PriceUpdateV2 / PriceFeed account)
// Anchor-discriminator(8) + writeAuthority(32) + VerificationLevel(enum) + PriceFeedMessage
// PriceFeedMessage: feedId[32], price i64, conf u64, exponent i32, publishTime i64, prevPublishTime i64, emaPrice i64, emaConf u64
fn parse_anchor_price_message(data: &[u8]) -> Option<(i64, i32, u64, i64)> {
    if data.len() < 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 { return None; }
    let mut off: usize = 8 + 32; // skip discriminator + writeAuthority
    let tag = *data.get(off)?; off += 1; // VerificationLevel tag
    match tag {
        0 => { // Partial(u8)
            if data.len() < off + 1 { return None; }
            off += 1;
        }
        1 => { /* Full */ }
        _ => return None,
    }
    if data.len() < off + 32 + 8 + 8 + 4 + 8 { return None; }
    off += 32; // feedId
    let price = i64::from_le_bytes(data[off..off+8].try_into().ok()?); off += 8;
    let conf  = u64::from_le_bytes(data[off..off+8].try_into().ok()?); off += 8;
    let expo  = i32::from_le_bytes(data[off..off+4].try_into().ok()?); off += 4;
    let pubts = i64::from_le_bytes(data[off..off+8].try_into().ok()?);
    if price == 0 { return None; }
    Some((price, expo, conf, pubts))
}

const PUSH_ORACLE_PROGRAM_ID: Pubkey = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

fn push_oracle_program_id() -> Pubkey { PUSH_ORACLE_PROGRAM_ID }
fn receiver_program_id() -> Pubkey { RECEIVER_PROGRAM_ID }

#[program]
pub mod reward_vault {
    use super::*;

    // Initialize the Reward Vault (single FORCA mint only)
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        fee_c_bps: u16,
        tax_d_bps: u16,
        margin_b_bps: u16,
    ) -> Result<()> {
        require!(fee_c_bps <= 10_000, RvError::InvalidBps);
        require!(tax_d_bps <= 10_000, RvError::InvalidBps);
        require!(margin_b_bps <= 10_000, RvError::InvalidBps);

        let mint = &ctx.accounts.forca_mint;
        // Enforce FORCA decimals = 6
        require!(mint.decimals == 6, RvError::InvalidForcaDecimals);

        let state = &mut ctx.accounts.vault_state;
        state.pop_admin = ctx.accounts.pop_admin.key();
        state.econ_admin = ctx.accounts.econ_admin.key();
        state.forca_mint = mint.key();
        state.fee_c_bps = fee_c_bps;
        state.tax_d_bps = tax_d_bps;
        state.margin_b_bps = margin_b_bps;
        state.paused = false;
        state.vault_signer_bump = ctx.bumps.vault_signer;
        // defaults for PoP params
        state.soft_daily_cap_usd_e6 = 1_000_000_000; // $1,000 default
        state.soft_cooldown_secs = 0; // default no cooldown
        state.forca_usd_e6 = 1_000_000; // default $1 per FORCA
        // oracle defaults
        state.verify_prices = false;
        state.oracle_tolerance_bps = 100; // 1%
        state.pyth_sol_usd_price_feed = Pubkey::default();
        state.canonical_pool_forca_sol = Pubkey::default();
        state.canonical_pool_forca_reserve = Pubkey::default();
        state.canonical_pool_sol_reserve = Pubkey::default();
        state.use_mock_oracle = false;
        state.mock_oracle_locked = false;
        state.pyth_max_stale_secs = 120; // default 2 minutes freshness window
        state.pyth_max_confidence_bps = DEFAULT_PYTH_MAX_CONFIDENCE_BPS;

        emit!(VaultInitialized {
            forca_mint: state.forca_mint,
            fee_c_bps,
            tax_d_bps,
            margin_b_bps,
        });
        Ok(())
    }

    pub fn set_pause(
        ctx: Context<EconAdminOnly>,
        pause: bool,
        reason_code: u16,
        max_duration_secs: u64,
    ) -> Result<()> {
        pause_reason_from_u16(reason_code)?;
        ctx.accounts.vault_state.paused = pause;
        let now = Clock::get()?.unix_timestamp;
        emit!(VaultPauseEvent {
            paused: pause,
            reason_code,
            max_duration_secs,
            set_ts: now,
        });
        Ok(())
    }

    pub fn set_params(
        ctx: Context<EconAdminOnly>,
        fee_c_bps: u16,
        tax_d_bps: u16,
        margin_b_bps: u16,
    ) -> Result<()> {
        require!(fee_c_bps <= 10_000, RvError::InvalidBps);
        require!(tax_d_bps <= 10_000, RvError::InvalidBps);
        require!(margin_b_bps <= 10_000, RvError::InvalidBps);
        let st = &mut ctx.accounts.vault_state;
        st.fee_c_bps = fee_c_bps;
        st.tax_d_bps = tax_d_bps;
        st.margin_b_bps = margin_b_bps;
        Ok(())
    }

    pub fn set_pop_params(
        ctx: Context<SetPopParams>,
        soft_daily_cap_usd_e6: u64,
        soft_cooldown_secs: u64,
        monthly_claim_limit: u16,
        hard_kyc_threshold_usd_e6: u64,
    ) -> Result<()> {
        require!(soft_daily_cap_usd_e6 >= MIN_POP_SOFT_DAILY_CAP_USD_E6, RvError::PopCapTooLow);
        require!(soft_cooldown_secs <= MAX_POP_SOFT_COOLDOWN_SECS, RvError::PopCooldownTooHigh);
        if monthly_claim_limit != 0 {
            require!(monthly_claim_limit >= MIN_POP_MONTHLY_CLAIM_LIMIT, RvError::PopMonthlyLimitTooLow);
            require!(monthly_claim_limit <= MAX_POP_MONTHLY_CLAIM_LIMIT, RvError::PopMonthlyLimitTooHigh);
        }
        if hard_kyc_threshold_usd_e6 != 0 {
            require!(hard_kyc_threshold_usd_e6 >= MIN_POP_HARD_KYC_THRESHOLD_USD_E6, RvError::PopHardCutTooLow);
        }
        let ally = &mut ctx.accounts.ally;
        let old_cap = ally.soft_daily_cap_usd_e6;
        let old_cooldown = ally.soft_cooldown_secs;
        let old_monthly_limit = ally.monthly_claim_limit;
        let old_hard_cut = ally.hard_kyc_threshold_usd_e6;
        ally.soft_daily_cap_usd_e6 = soft_daily_cap_usd_e6;
        ally.soft_cooldown_secs = soft_cooldown_secs;
        ally.monthly_claim_limit = monthly_claim_limit;
        ally.hard_kyc_threshold_usd_e6 = hard_kyc_threshold_usd_e6;
        let now = Clock::get()?.unix_timestamp;
        emit!(PopParamsUpdated {
            ally_nft_mint: ally.nft_mint,
            old_soft_daily_cap_usd_e6: old_cap,
            old_soft_cooldown_secs: old_cooldown,
            old_monthly_claim_limit: old_monthly_limit,
            old_hard_kyc_threshold_usd_e6: old_hard_cut,
            new_soft_daily_cap_usd_e6: soft_daily_cap_usd_e6,
            new_soft_cooldown_secs: soft_cooldown_secs,
            new_monthly_claim_limit: monthly_claim_limit,
            new_hard_kyc_threshold_usd_e6: hard_kyc_threshold_usd_e6,
            signer: ctx.accounts.withdraw_authority.key(),
            set_ts: now,
        });
        Ok(())
    }

    pub fn set_forca_usd(ctx: Context<PopAdminOnly>, forca_usd_e6: u64) -> Result<()> {
        let st = &mut ctx.accounts.vault_state;
        require!(st.use_mock_oracle, RvError::ManualForcaUsdDisabled);
        st.forca_usd_e6 = forca_usd_e6;
        Ok(())
    }

    pub fn set_oracle_config(
        ctx: Context<EconAdminOnly>,
        verify_prices: bool,
        oracle_tolerance_bps: u16,
        pyth_sol_usd_price_feed: Pubkey,
        canonical_pool_forca_sol: Pubkey,
        canonical_pool_forca_reserve: Pubkey,
        canonical_pool_sol_reserve: Pubkey,
        use_mock_oracle: bool,
        pyth_max_stale_secs: u64,
        pyth_max_confidence_bps: u16,
    ) -> Result<()> {
        require!(oracle_tolerance_bps <= 10_000, RvError::InvalidBps);
        require!(pyth_max_confidence_bps > 0 && pyth_max_confidence_bps <= 10_000, RvError::InvalidBps);
        let st = &mut ctx.accounts.vault_state;
        if st.verify_prices && !verify_prices {
            return err!(RvError::VerifyPricesLocked);
        }
        if st.mock_oracle_locked && use_mock_oracle {
            return err!(RvError::MockOracleLocked);
        }
        if verify_prices && !use_mock_oracle {
            require!(pyth_sol_usd_price_feed != Pubkey::default(), RvError::OracleMissing);
            require!(canonical_pool_forca_sol != Pubkey::default(), RvError::OracleMissing);
            require!(canonical_pool_forca_reserve != Pubkey::default(), RvError::OracleMissing);
            require!(canonical_pool_sol_reserve != Pubkey::default(), RvError::OracleMissing);
        }
        st.verify_prices = verify_prices;
        st.oracle_tolerance_bps = oracle_tolerance_bps;
        st.pyth_sol_usd_price_feed = pyth_sol_usd_price_feed;
        st.canonical_pool_forca_sol = canonical_pool_forca_sol;
        st.canonical_pool_forca_reserve = canonical_pool_forca_reserve;
        st.canonical_pool_sol_reserve = canonical_pool_sol_reserve;
        st.use_mock_oracle = use_mock_oracle;
        if !use_mock_oracle {
            st.mock_oracle_locked = true;
        }
        st.pyth_max_stale_secs = pyth_max_stale_secs;
        st.pyth_max_confidence_bps = pyth_max_confidence_bps;
        Ok(())
    }

    pub fn set_econ_admin(ctx: Context<EconAdminOnly>, new_econ_admin: Pubkey) -> Result<()> {
        require!(new_econ_admin != Pubkey::default(), RvError::InvalidAuthority);
        let st = &mut ctx.accounts.vault_state;
        let old = st.econ_admin;
        st.econ_admin = new_econ_admin;
        emit!(EconAdminUpdated {
            old_econ_admin: old,
            new_econ_admin,
            set_ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn set_pop_admin(ctx: Context<PopAdminOnly>, new_pop_admin: Pubkey) -> Result<()> {
        require!(new_pop_admin != Pubkey::default(), RvError::InvalidAuthority);
        let st = &mut ctx.accounts.vault_state;
        let old = st.pop_admin;
        st.pop_admin = new_pop_admin;
        emit!(PopAdminUpdated {
            old_pop_admin: old,
            new_pop_admin,
            set_ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn set_mock_oracles(
        ctx: Context<SetMockOracles>,
        sol_usd_e6: u64,
        forca_per_sol_e6: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mo = &mut ctx.accounts.mock_oracle_sol;
        mo.sol_usd_e6 = sol_usd_e6;
        mo.expo_i32 = 8; // price in 1e-8 units equivalent
        mo.conf_e8 = 1_000; // example conf in 1e-8
        mo.publish_ts = now;

        let mp = &mut ctx.accounts.mock_pool_forca;
        mp.forca_per_sol_e6 = forca_per_sol_e6;
        mp.reserve_forca_e6 = 1_000_000_000; // 1,000 FORCA default reserves
        mp.reserve_sol_e9 = 10_000_000_000; // 10 SOL default reserves
        Ok(())
    }

    pub fn set_pop_level(ctx: Context<SetPopLevel>, level: PopLevel) -> Result<()> {
        let profile = &mut ctx.accounts.pop_profile;
        if profile.user == Pubkey::default() {
            profile.user = ctx.accounts.user.key();
        }
        require_keys_eq!(profile.user, ctx.accounts.user.key(), RvError::InvalidAuthority);
        profile.bump = ctx.bumps.pop_profile;
        profile.level = level as u8;
        profile.last_set_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    // Register a StoryFi Ally identified by an NFT mint and two authorities (ops + withdraw)
    pub fn register_ally(
        ctx: Context<RegisterAlly>,
        role: AllyRole,
    ) -> Result<()> {
        let ally = &mut ctx.accounts.ally;
        ally.nft_mint = ctx.accounts.ally_nft_mint.key();
        ally.ops_authority = ctx.accounts.ops_authority.key();
        ally.withdraw_authority = ctx.accounts.withdraw_authority.key();
        ally.treasury_ata = ctx.accounts.ally_treasury_ata.key();
        ally.vault_ata = ctx.accounts.ally_vault_ata.key();
        ally.role = role as u8;
        ally.balance_forca = 0;
        ally.rp_reserved = 0;
        ally.benefit_mode = BenefitMode::None as u8;
        ally.benefit_bps = 0;
        ally.pop_enforced = true;
        ally.soft_daily_cap_usd_e6 = ctx.accounts.vault_state.soft_daily_cap_usd_e6;
        ally.soft_cooldown_secs = ctx.accounts.vault_state.soft_cooldown_secs;
        ally.monthly_claim_limit = 0;
        ally.hard_kyc_threshold_usd_e6 = 0;

        // Treasury ATA mint must match vault FORCA mint
        require_keys_eq!(ctx.accounts.ally_treasury_ata.mint, ctx.accounts.vault_state.forca_mint, RvError::InvalidMint);
        require_keys_eq!(ctx.accounts.ally_vault_ata.mint, ctx.accounts.vault_state.forca_mint, RvError::InvalidMint);

        emit!(AllyRegistered {
            ally_nft_mint: ally.nft_mint,
            ops_authority: ally.ops_authority,
            withdraw_authority: ally.withdraw_authority,
            role: ally.role,
            treasury_ata: ally.treasury_ata,
            vault_ata: ally.vault_ata,
        });
        Ok(())
    }

    pub fn set_ally_benefit(ctx: Context<SetAllyBenefit>, mode: BenefitMode, bps: u16) -> Result<()> {
        require!(bps <= 10_000, RvError::InvalidBps);
        let ally = &mut ctx.accounts.ally;
        ally.benefit_mode = mode as u8;
        ally.benefit_bps = bps;
        emit!(AllyBenefitSet { ally_nft_mint: ally.nft_mint, mode: ally.benefit_mode, bps });
        Ok(())
    }

    pub fn set_ally_pop_enforcement(ctx: Context<SetAllyPopEnforcement>, enforce: bool) -> Result<()> {
        let ally = &mut ctx.accounts.ally;
        ally.pop_enforced = enforce;
        emit!(AllyPopEnforcementSet { ally_nft_mint: ally.nft_mint, pop_enforced: enforce });
        Ok(())
    }

    pub fn set_ally_ops_authority(
        ctx: Context<SetAllyOpsAuthority>,
        new_ops_authority: Pubkey,
    ) -> Result<()> {
        require!(new_ops_authority != Pubkey::default(), RvError::InvalidAuthority);
        let ally = &mut ctx.accounts.ally;
        let old = ally.ops_authority;
        ally.ops_authority = new_ops_authority;
        emit!(AllyOpsAuthorityUpdated {
            ally_nft_mint: ally.nft_mint,
            old_ops_authority: old,
            new_ops_authority,
            set_ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn set_ally_withdraw_authority(
        ctx: Context<SetAllyWithdrawAuthority>,
        new_withdraw_authority: Pubkey,
    ) -> Result<()> {
        require!(new_withdraw_authority != Pubkey::default(), RvError::InvalidAuthority);
        require_keys_eq!(
            ctx.accounts.new_treasury_ata.owner,
            new_withdraw_authority,
            RvError::InvalidAuthority
        );

        let ally = &mut ctx.accounts.ally;
        let old_withdraw = ally.withdraw_authority;
        let old_treasury = ally.treasury_ata;
        ally.withdraw_authority = new_withdraw_authority;
        ally.treasury_ata = ctx.accounts.new_treasury_ata.key();

        emit!(AllyWithdrawAuthorityUpdated {
            ally_nft_mint: ally.nft_mint,
            old_withdraw_authority: old_withdraw,
            new_withdraw_authority,
            old_treasury_ata: old_treasury,
            new_treasury_ata: ally.treasury_ata,
            set_ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // migrate_ledger removed (pre-mainnet cleanup)

    // StoryFi Ally deposits FORCA into the central vault custody (tracked per-ally balance)
    pub fn deposit_forca(ctx: Context<AllyDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, RvError::ZeroAmount);

        // Verify token mints
        require_keys_eq!(ctx.accounts.vault_state.forca_mint, ctx.accounts.ally_treasury_ata.mint, RvError::InvalidMint);
        require_keys_eq!(ctx.accounts.vault_state.forca_mint, ctx.accounts.ally_vault_ata.mint, RvError::InvalidMint);
        require_keys_eq!(ctx.accounts.ally_vault_ata.key(), ctx.accounts.ally.vault_ata, RvError::InvalidVaultAta);

        // Transfer from ally treasury to vault_ata (authority: withdraw_authority)
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.ally_treasury_ata.to_account_info(),
                to: ctx.accounts.ally_vault_ata.to_account_info(),
                authority: ctx.accounts.withdraw_authority.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;

        // Update ally balance
        let ally = &mut ctx.accounts.ally;
        ally.balance_forca = ally
            .balance_forca
            .checked_add(amount)
            .ok_or(RvError::Overflow)?;

        require!(ally.balance_forca >= ally.rp_reserved, RvError::InsufficientUnreservedBalance);

        emit!(AllyDepositEvent {
            ally_nft_mint: ally.nft_mint,
            amount,
        });
        Ok(())
    }

    // StoryFi Ally withdraws FORCA from central vault (deduct per-ally balance)
    pub fn withdraw_forca(ctx: Context<AllyWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, RvError::ZeroAmount);

        let ally = &mut ctx.accounts.ally;
        // Non-custodial: only the Ally's withdraw authority can authorize withdrawals.
        require_keys_eq!(ctx.accounts.ally_vault_ata.key(), ally.vault_ata, RvError::InvalidVaultAta);
        require!(ally.balance_forca >= amount, RvError::InsufficientAllyBalance);
        let remaining = ally
            .balance_forca
            .checked_sub(amount)
            .ok_or(RvError::Overflow)?;
        require!(remaining >= ally.rp_reserved, RvError::InsufficientUnreservedBalance);

        // Transfer from ally vault (authority: vault_signer) to ally treasury
        let seeds: &[&[u8]] = &[b"vault_signer", &[ctx.accounts.vault_state.vault_signer_bump]];
        let signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.ally_vault_ata.to_account_info(),
                to: ctx.accounts.ally_treasury_ata.to_account_info(),
                authority: ctx.accounts.vault_signer.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        // Update balance
        ally.balance_forca = remaining;

        emit!(AllyWithdrawEvent {
            ally_nft_mint: ally.nft_mint,
            amount,
        });
        Ok(())
    }

    // User converts FORCA -> PP for a specific Ally (NFT-scoped sub-ledger).
    // Margin B% is retained by the Ally; program acts as a passive ledger and never routes fees to the tech provider.
    // Also writes quote evidence on-chain.
    pub fn convert_to_scoped_pp(
        ctx: Context<ConvertToScopedPP>,
        amount_forca: u64,
        sol_price_usd_e6: u64,
        forca_per_sol_e6: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.vault_state.paused, RvError::Paused);
        require!(amount_forca > 0, RvError::ZeroAmount);

        let st = &ctx.accounts.vault_state;
        // Disallow unverified pricing: require verify_prices to be enabled.
        require!(st.verify_prices, RvError::OracleMissing);
        // For event enrichment
        let mut pyth_expo_i32_out: i32 = 0;
        let mut pyth_conf_e8_out: u64 = 0;
        let mut pyth_publish_ts_out: i64 = 0;

        // Verify mints
        let forca_mint = st.forca_mint;
        require_keys_eq!(ctx.accounts.user_ata.mint, forca_mint, RvError::InvalidMint);
        require_keys_eq!(ctx.accounts.ally_vault_ata.mint, forca_mint, RvError::InvalidMint);
        require_keys_eq!(ctx.accounts.ally_vault_ata.key(), ctx.accounts.ally.vault_ata, RvError::InvalidVaultAta);
        // Disallow delegate-based spending; enforce user_ata is owned by user
        require_keys_eq!(ctx.accounts.user_ata.owner, ctx.accounts.user.key(), RvError::InvalidAuthority);

        // Oracle verification (Pyth + canonical pool or mock)
        if st.verify_prices {
            if st.use_mock_oracle {
                let mo = &ctx.accounts.mock_oracle_sol;
                let mp = &ctx.accounts.mock_pool_forca;
                require!(within_bps(sol_price_usd_e6, mo.sol_usd_e6, st.oracle_tolerance_bps), RvError::OracleOutOfTolerance);
                require!(within_bps(forca_per_sol_e6, mp.forca_per_sol_e6, st.oracle_tolerance_bps), RvError::OracleOutOfTolerance);
            } else {
                // Check proof account keys match configured ones
                let pyth_ai = &ctx.accounts.pyth_sol_usd_price_feed;
                let pool_ai = &ctx.accounts.canonical_pool_forca_sol;
                require_keys_eq!(pyth_ai.key(), st.pyth_sol_usd_price_feed, RvError::OracleKeyMismatch);
                require_keys_eq!(pool_ai.key(), st.canonical_pool_forca_sol, RvError::OracleKeyMismatch);
                require_keys_eq!(ctx.accounts.pool_forca_reserve.key(), st.canonical_pool_forca_reserve, RvError::OracleKeyMismatch);
                require_keys_eq!(ctx.accounts.pool_sol_reserve.key(), st.canonical_pool_sol_reserve, RvError::OracleKeyMismatch);
                // Reserve token account sanity checks (owner = canonical pool authority; mints as expected)
                require_keys_eq!(ctx.accounts.pool_forca_reserve.mint, st.forca_mint, RvError::InvalidMint);
                require_keys_eq!(ctx.accounts.pool_sol_reserve.mint, wsol_mint(), RvError::InvalidMint);
                require_keys_eq!(ctx.accounts.pool_forca_reserve.owner, st.canonical_pool_forca_sol, RvError::OracleKeyMismatch);
                require_keys_eq!(ctx.accounts.pool_sol_reserve.owner, st.canonical_pool_forca_sol, RvError::OracleKeyMismatch);
                // Anchor-style PriceUpdateV2/PriceFeed only (owner = Push Oracle or Receiver)
                let data = pyth_ai.try_borrow_data()?;
                let owner = pyth_ai.owner;
                require!(*owner == push_oracle_program_id() || *owner == receiver_program_id(), RvError::OracleParseFailed);
                if let Some((px, expo, conf_e8, pub_ts)) = parse_anchor_price_message(&data) {
                    // stale check
                    let now = Clock::get()?.unix_timestamp;
                    require!(pub_ts <= now, RvError::OracleParseFailed);
                    let age = now.checked_sub(pub_ts).ok_or(RvError::Overflow)? as u64;
                    require!(age <= st.pyth_max_stale_secs, RvError::OracleStale);
                    if st.pyth_max_confidence_bps > 0 {
                        let conf_bps = conf_bps_from_price(px, conf_e8).ok_or(RvError::OracleParseFailed)?;
                        require!(conf_bps <= st.pyth_max_confidence_bps as u128, RvError::OracleConfidenceTooWide);
                    }

                    pyth_expo_i32_out = expo;
                    pyth_conf_e8_out = conf_e8;
                    pyth_publish_ts_out = pub_ts;
                    if let Some(derived_sol_usd_e6) = scale_price_to_e6(px, expo) {
                        require!(within_bps(sol_price_usd_e6, derived_sol_usd_e6, st.oracle_tolerance_bps), RvError::OracleOutOfTolerance);
                    } else {
                        return err!(RvError::OracleParseFailed);
                    }
                } else {
                    return err!(RvError::OracleParseFailed);
                }
                // Canonical pool derived FORCA/SOL from reserve token accounts
                let rf = ctx.accounts.pool_forca_reserve.amount as u128; // FORCA 1e6
                let rs = ctx.accounts.pool_sol_reserve.amount as u128;   // SOL 1e9
                require!(rs > 0, RvError::OracleParseFailed);
                let mut derived = rf.checked_mul(WSOL_SCALE_U128).ok_or(RvError::Overflow)?;
                derived = derived.checked_div(rs).ok_or(RvError::Overflow)?;
                let derived_u64 = u64::try_from(derived).map_err(|_| RvError::Overflow)?;
                require!(within_bps(forca_per_sol_e6, derived_u64, st.oracle_tolerance_bps), RvError::OracleOutOfTolerance);
            }
        }

        let amount_u128 = amount_forca as u128;
        let ally_acc = &mut ctx.accounts.ally;

        // Always apply margin B% (retained in Ally custody)
        let margin = amount_u128
            .checked_mul(st.margin_b_bps as u128)
            .ok_or(RvError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(RvError::Overflow)? as u64; // floor

        let base_after_margin = amount_forca
            .checked_sub(margin)
            .ok_or(RvError::Overflow)?;

        // Benefit logic on base_after_margin
        // Track HWM 감소 기준: 사용자의 실제 지갑 유출액 = amount_forca - discount(있다면)
        let mut hwm_reduce_by: u64 = amount_forca;
        let mut benefit_mode_out: u8 = ally_acc.benefit_mode;
        let mut benefit_bps_out: u16 = ally_acc.benefit_bps;
        let mut discount_forca_out: u64 = 0;
        let mut bonus_pp_e6_out: u64 = 0;
        let (ally_receive_forca, _bonus_pp_e6) = if ally_acc.benefit_bps > 0 {
            let bps = ally_acc.benefit_bps as u128;
            match benefit_mode_from_u8(ally_acc.benefit_mode)? {
                BenefitMode::Discount => {
                    let discount = ((base_after_margin as u128)
                        .checked_mul(bps)
                        .ok_or(RvError::Overflow)?
                        .checked_div(BPS_DENOMINATOR)
                        .ok_or(RvError::Overflow)?) as u64;
                    // 사용자의 실제 지갑 유출액 반영: 전체 입력에서 할인분을 제외
                    hwm_reduce_by = hwm_reduce_by
                        .checked_sub(discount)
                        .ok_or(RvError::Overflow)?;
                    discount_forca_out = discount;
                    let net_to_ally = base_after_margin
                        .checked_sub(discount)
                        .ok_or(RvError::Overflow)?;
                    (net_to_ally, 0u64)
                }
                BenefitMode::BonusPP => {
                    (base_after_margin, 1u64)
                }
                BenefitMode::None => (base_after_margin, 0u64),
            }
        } else {
            benefit_mode_out = BenefitMode::None as u8;
            benefit_bps_out = 0;
            (base_after_margin, 0u64)
        };

        // user -> ally vault for full retained amount (margin + net after discount)
        let total_to_ally = ally_receive_forca
            .checked_add(margin)
            .ok_or(RvError::Overflow)?;
        if total_to_ally > 0 {
            let cpi1 = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.ally_vault_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            );
            token::transfer(cpi1, total_to_ally)?;
        }

        // Compute PP = floor(amount_forca * (SOL_USD_e6 / FORCA_PER_SOL_e6))
        require!(forca_per_sol_e6 > 0, RvError::InvalidQuote);
        let pp_delta_u128 = (amount_u128)
            .checked_mul(sol_price_usd_e6 as u128)
            .ok_or(RvError::Overflow)?
            .checked_div(forca_per_sol_e6 as u128)
            .ok_or(RvError::Overflow)?;
        let pp_delta = u64::try_from(pp_delta_u128).map_err(|_| RvError::Overflow)?; // in micro-USD PP units

        // Increase ally custody balance by actual on-chain inflow (non-custodial ledger)
        ally_acc.balance_forca = ally_acc
            .balance_forca
            .checked_add(total_to_ally)
            .ok_or(RvError::Overflow)?;

        require!(ally_acc.balance_forca >= ally_acc.rp_reserved, RvError::InsufficientUnreservedBalance);

        // Init or update ledger
        let ledger = &mut ctx.accounts.user_ledger;
        if ledger.user == Pubkey::default() {
            ledger.user = ctx.accounts.user.key();
            ledger.ally_nft_mint = ally_acc.nft_mint;
            ledger.rp_claimable_forca = 0;
            ledger.pp_balance = 0;
            ledger.hwm_claimed = 0;
            ledger.tax_hwm = 0;
            ledger.total_claimed_forca = 0;
            ledger.bump = ctx.bumps.user_ledger;
            ledger.created_ts = Clock::get()?.unix_timestamp;
        }
        // Increase PP
        let mut total_pp = pp_delta;
        if ally_acc.benefit_bps > 0 {
            match benefit_mode_from_u8(ally_acc.benefit_mode)? {
                BenefitMode::Discount => {
                    // discount: same PP based on gross, already computed
                }
                BenefitMode::BonusPP => {
                    let bonus = ((pp_delta as u128)
                        .checked_mul(ally_acc.benefit_bps as u128)
                        .ok_or(RvError::Overflow)?
                        .checked_div(BPS_DENOMINATOR)
                        .ok_or(RvError::Overflow)?) as u64;
                    total_pp = total_pp.checked_add(bonus).ok_or(RvError::Overflow)?;
                    bonus_pp_e6_out = bonus;
                }
                BenefitMode::None => {}
            }
        }
        ledger.pp_balance = ledger.pp_balance.checked_add(total_pp).ok_or(RvError::Overflow)?;
        // Convert 후, 사용자 지갑의 HWM을 실제 유출액만큼 감소시켜 다음 청구의 과세 기준을 낮춤
        let cur_hwm_before = ledger.hwm_claimed;
        let new_hwm_after = if cur_hwm_before >= hwm_reduce_by {
            cur_hwm_before
                .checked_sub(hwm_reduce_by)
                .ok_or(RvError::Overflow)?
        } else { 0 };
        ledger.hwm_claimed = new_hwm_after;
        ledger.updated_ts = Clock::get()?.unix_timestamp;

        emit!(ConvertToPPEvent {
            user: ctx.accounts.user.key(),
            ally_nft_mint: ctx.accounts.ally.nft_mint,
            amount_forca,
            margin_b: margin,
            pp_delta,
            sol_price_usd_e6,
            forca_per_sol_e6,
            pyth_price_feed: st.pyth_sol_usd_price_feed,
            canonical_pool: st.canonical_pool_forca_sol,
            verify_prices: st.verify_prices,
            oracle_tolerance_bps: st.oracle_tolerance_bps,
            pyth_expo_i32: if st.use_mock_oracle { ctx.accounts.mock_oracle_sol.expo_i32 } else { pyth_expo_i32_out },
            pyth_conf_e8: if st.use_mock_oracle { ctx.accounts.mock_oracle_sol.conf_e8 } else { pyth_conf_e8_out },
            pyth_publish_ts: if st.use_mock_oracle { ctx.accounts.mock_oracle_sol.publish_ts } else { pyth_publish_ts_out },
            cur_hwm: cur_hwm_before,
            new_hwm: new_hwm_after,
            tax_hwm: ledger.tax_hwm,
            benefit_mode: benefit_mode_out,
            benefit_bps: benefit_bps_out,
            discount_forca: discount_forca_out,
            bonus_pp_e6: bonus_pp_e6_out,
        });
        Ok(())
    }

    // Ally allocates claimable RP (simplified: denominated in FORCA-equivalent for MVP)
    pub fn allocate_claimable_rp(ctx: Context<AllocateRP>, forca_equiv_amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault_state.paused, RvError::Paused);
        require!(forca_equiv_amount > 0, RvError::ZeroAmount);
        let ally = &mut ctx.accounts.ally;
        let ledger = &mut ctx.accounts.user_ledger;
        require!(ledger.user != Pubkey::default(), RvError::InvalidAuthority);
        require_keys_eq!(ledger.ally_nft_mint, ally.nft_mint, RvError::InvalidAuthority);
        let pop_profile = &mut ctx.accounts.pop_profile;
        if pop_profile.user == Pubkey::default() {
            pop_profile.user = ledger.user;
            pop_profile.bump = ctx.bumps.pop_profile;
        }
        if ally.pop_enforced {
            let level = pop_profile.level;
            require!(level == PopLevel::Soft as u8 || level == PopLevel::Strong as u8, RvError::PopDenied);
        }

        let new_reserved = ally
            .rp_reserved
            .checked_add(forca_equiv_amount)
            .ok_or(RvError::Overflow)?;
        require!(ally.balance_forca >= new_reserved, RvError::InsufficientVaultBalance);
        ally.rp_reserved = new_reserved;

        ledger.rp_claimable_forca = ledger
            .rp_claimable_forca
            .checked_add(forca_equiv_amount)
            .ok_or(RvError::Overflow)?;
        ledger.updated_ts = Clock::get()?.unix_timestamp;

        emit!(AllocateRPEvent {
            user: ledger.user,
            ally_nft_mint: ledger.ally_nft_mint,
            forca_equiv_amount,
        });
        Ok(())
    }

    // Ally cancels previously allocated (but not yet claimed) RP for a user, freeing reserve
    pub fn cancel_allocated_rp(ctx: Context<CancelRP>, cancel_amount: u64) -> Result<()> {
        require!(cancel_amount > 0, RvError::ZeroAmount);

        let ally = &mut ctx.accounts.ally;
        let ledger = &mut ctx.accounts.user_ledger;
        require!(ledger.user != Pubkey::default(), RvError::InvalidAuthority);
        require_keys_eq!(ledger.ally_nft_mint, ally.nft_mint, RvError::InvalidAuthority);

        require!(ledger.rp_claimable_forca >= cancel_amount, RvError::InsufficientRP);
        require!(ally.rp_reserved >= cancel_amount, RvError::InsufficientReservedBalance);

        ledger.rp_claimable_forca = ledger
            .rp_claimable_forca
            .checked_sub(cancel_amount)
            .ok_or(RvError::Overflow)?;
        ledger.updated_ts = Clock::get()?.unix_timestamp;

        ally.rp_reserved = ally
            .rp_reserved
            .checked_sub(cancel_amount)
            .ok_or(RvError::Overflow)?;

        emit!(CancelRPEvent {
            user: ledger.user,
            ally_nft_mint: ledger.ally_nft_mint,
            cancel_amount,
        });

        Ok(())
    }

    // Ally grants bonus PP to a specific user (ledger scoped by Ally NFT)
    pub fn grant_bonus_pp(ctx: Context<GrantBonusPP>, amount_pp_e6: u64) -> Result<()> {
        require!(amount_pp_e6 > 0, RvError::ZeroAmount);

        let now = Clock::get()?.unix_timestamp;

        // Initialize or update the user's ledger scoped to this Ally
        let ledger = &mut ctx.accounts.user_ledger;
        if ledger.user == Pubkey::default() {
            ledger.user = ctx.accounts.user.key();
            ledger.ally_nft_mint = ctx.accounts.ally.nft_mint;
            ledger.rp_claimable_forca = 0;
            ledger.pp_balance = 0;
            ledger.hwm_claimed = 0;
            ledger.tax_hwm = 0;
            ledger.total_claimed_forca = 0;
            ledger.bump = ctx.bumps.user_ledger;
            ledger.created_ts = now;
        } else {
            // Sanity: ensure this ledger matches the provided user and ally scope
            require_keys_eq!(ledger.user, ctx.accounts.user.key(), RvError::InvalidAuthority);
            require_keys_eq!(ledger.ally_nft_mint, ctx.accounts.ally.nft_mint, RvError::InvalidAuthority);
        }

        ledger.pp_balance = ledger
            .pp_balance
            .checked_add(amount_pp_e6)
            .ok_or(RvError::Overflow)?;
        ledger.updated_ts = now;

        emit!(GrantBonusPPEvent {
            user: ledger.user,
            ally_nft_mint: ledger.ally_nft_mint,
            amount_pp_e6,
        });

        Ok(())
    }

    // User claims RP into FORCA; fees C and D are retained by the Ally (no on-chain tech custody).
    pub fn claim_rp(ctx: Context<ClaimRP>, amount_forca: u64) -> Result<()> {
        require!(amount_forca > 0, RvError::ZeroAmount);
        require!(!ctx.accounts.vault_state.paused, RvError::Paused);

        // Check ledger allowance
        let ledger = &mut ctx.accounts.user_ledger;
        require!(ledger.rp_claimable_forca >= amount_forca, RvError::InsufficientRP);

        // Verify mints
        require_keys_eq!(ctx.accounts.user_ata.mint, ctx.accounts.vault_state.forca_mint, RvError::InvalidMint);
        require_keys_eq!(ctx.accounts.ally_vault_ata.mint, ctx.accounts.vault_state.forca_mint, RvError::InvalidMint);
        // Ensure the recipient ATA is owned by the claiming user (prevent misdirected withdrawals)
        require_keys_eq!(ctx.accounts.user_ata.owner, ctx.accounts.user.key(), RvError::InvalidAuthority);

        let ally = &mut ctx.accounts.ally;
        let pop_profile = &mut ctx.accounts.pop_profile;
        if pop_profile.user == Pubkey::default() {
            pop_profile.user = ctx.accounts.user.key();
            pop_profile.bump = ctx.bumps.pop_profile;
        }
        require_keys_eq!(ctx.accounts.ally_vault_ata.key(), ally.vault_ata, RvError::InvalidVaultAta);
        require!(ally.balance_forca >= amount_forca, RvError::InsufficientVaultBalance);
        require!(ally.rp_reserved >= amount_forca, RvError::InsufficientReservedBalance);

        let now = Clock::get()?.unix_timestamp;
        let level = pop_profile.level;
        let strong_like = level == PopLevel::Strong as u8;
        let new_total_claimed = ledger
            .total_claimed_forca
            .checked_add(amount_forca)
            .ok_or(RvError::Overflow)?;
        let st = &ctx.accounts.vault_state;
        let need_forca_usd = !strong_like && (ally.pop_enforced || ally.hard_kyc_threshold_usd_e6 > 0);
        let forca_usd_e6 = if need_forca_usd {
            // Use oracle/DEX-derived price in production; fallback to manual in mock/emergency.
            resolve_forca_usd_e6(
                st,
                now,
                &ctx.accounts.pyth_sol_usd_price_feed,
                &ctx.accounts.canonical_pool_forca_sol,
                ctx.accounts.pool_forca_reserve.key(),
                ctx.accounts.pool_sol_reserve.key(),
                &ctx.accounts.pool_forca_reserve,
                &ctx.accounts.pool_sol_reserve,
            )?
        } else {
            0
        };
        if need_forca_usd {
            require!(forca_usd_e6 > 0, RvError::OracleParseFailed);
        }
        if !strong_like && ally.hard_kyc_threshold_usd_e6 > 0 {
            let total_claimed_usd_u128 = (new_total_claimed as u128)
                .checked_mul(forca_usd_e6 as u128)
                .ok_or(RvError::Overflow)?
                .checked_div(1_000_000u128)
                .ok_or(RvError::Overflow)?;
            let total_claimed_usd_e6 = u64::try_from(total_claimed_usd_u128).map_err(|_| RvError::Overflow)?;
            require!(total_claimed_usd_e6 <= ally.hard_kyc_threshold_usd_e6, RvError::KycRequired);
        }

        let mut bump_month_claims = false;
        let cg = &mut ctx.accounts.claim_guard;
        // PoP gating (Suspicious/Soft apply guards; Strong bypasses) is ally-configurable.
        if ally.pop_enforced && !strong_like {
            if cg.user == Pubkey::default() {
                cg.user = ctx.accounts.user.key();
                cg.ally_nft_mint = ally.nft_mint;
                cg.day = now / 86_400;
                cg.used_usd_e6 = 0;
                cg.last_claim_ts = 0;
                cg.month_index = month_index_from_ts(now);
                cg.month_claims = 0;
                cg.bump = ctx.bumps.claim_guard;
            }
            let month_index = month_index_from_ts(now);
            if cg.month_index != month_index {
                cg.month_index = month_index;
                cg.month_claims = 0;
            }
            if ally.monthly_claim_limit > 0 {
                require!(cg.month_claims < ally.monthly_claim_limit, RvError::MonthlyClaimLimitExceeded);
                bump_month_claims = true;
            }
            // compute USD value (micro USD) using FORCA/USD price
            let usd_e6_u128 = (amount_forca as u128)
                .checked_mul(forca_usd_e6 as u128)
                .ok_or(RvError::Overflow)?
                .checked_div(1_000_000u128)
                .ok_or(RvError::Overflow)?;
            let usd_e6 = u64::try_from(usd_e6_u128).map_err(|_| RvError::Overflow)?;

            let day = now / 86_400;
            // rotate day
            if cg.day != day {
                cg.day = day;
                cg.used_usd_e6 = 0;
            }
            // cap check
            let new_used_u128 = (cg.used_usd_e6 as u128)
                .checked_add(usd_e6 as u128)
                .ok_or(RvError::Overflow)?;
            let new_used = u64::try_from(new_used_u128).map_err(|_| RvError::Overflow)?;
            require!(new_used <= ally.soft_daily_cap_usd_e6, RvError::SoftDailyCapExceeded);
            // cooldown
            if ally.soft_cooldown_secs > 0 {
                let since = now.checked_sub(cg.last_claim_ts).ok_or(RvError::Overflow)?;
                require!(since as u64 >= ally.soft_cooldown_secs, RvError::CooldownNotElapsed);
            }
            cg.used_usd_e6 = new_used;
            cg.last_claim_ts = now;
        }

        // Compute fees: base fee C on gross, then true HWM-on-excess D
        // new_hwm = cur_hwm + claim_basis, where claim_basis = amount_forca - fee_c
        // excess = max(0, new_hwm - tax_hwm); tax_d = D% of excess; then tax_hwm = new_hwm
        let amount_u128 = amount_forca as u128;
        // Base fee C on gross
        let fee_c = (amount_u128
            .checked_mul(st.fee_c_bps as u128)
            .ok_or(RvError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(RvError::Overflow)?) as u64;

        // Claim basis = net after C
        let claim_basis = amount_forca
            .checked_sub(fee_c)
            .ok_or(RvError::Overflow)?;

        // HWM-on-excess for D
        let cur_hwm_u64 = ledger.hwm_claimed;
        let cur_hwm = cur_hwm_u64 as u128;
        let prev_tax_hwm = ledger.tax_hwm as u128;
        let new_hwm_u128 = cur_hwm
            .checked_add(claim_basis as u128)
            .ok_or(RvError::Overflow)?;
        let excess_u128 = if new_hwm_u128 > prev_tax_hwm {
            new_hwm_u128
                .checked_sub(prev_tax_hwm)
                .ok_or(RvError::Overflow)?
        } else {
            0u128
        };
        let tax_d_u128 = excess_u128
            .checked_mul(st.tax_d_bps as u128)
            .ok_or(RvError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(RvError::Overflow)?;
        let tax_d = u64::try_from(tax_d_u128).map_err(|_| RvError::Overflow)?;

        let fee_total = fee_c
            .checked_add(tax_d)
            .ok_or(RvError::Overflow)?;
        require!(amount_forca > fee_total, RvError::AmountTooSmallAfterFee);
        // Net to user = claim_basis - tax_d
        let net = claim_basis.checked_sub(tax_d).ok_or(RvError::Overflow)?;

        // Transfers: from ally vault (authority: vault_signer) -> user only
        // Non-custodial principle: admin authorities never sign or withdraw from ally_vault_ata.
        let seeds: &[&[u8]] = &[b"vault_signer", &[st.vault_signer_bump]];
        let signer = &[&seeds[..]];

        // vault -> user (net)
        let c1 = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.ally_vault_ata.to_account_info(),
                to: ctx.accounts.user_ata.to_account_info(),
                authority: ctx.accounts.vault_signer.to_account_info(),
            },
            signer,
        );
        token::transfer(c1, net)?;

        // Update ledger
        ledger.rp_claimable_forca = ledger
            .rp_claimable_forca
            .checked_sub(amount_forca)
            .ok_or(RvError::Overflow)?;
        // Update HWM: track cumulative claim basis (pre-D) and move tax watermark to new_hwm
        let new_hwm = u64::try_from(new_hwm_u128).map_err(|_| RvError::Overflow)?;
        ledger.hwm_claimed = new_hwm;
        ledger.tax_hwm = new_hwm;
        ledger.total_claimed_forca = new_total_claimed;
        ledger.updated_ts = now;

        if bump_month_claims {
            cg.month_claims = cg.month_claims.checked_add(1).ok_or(RvError::Overflow)?;
        }

        ally.rp_reserved = ally
            .rp_reserved
            .checked_sub(amount_forca)
            .ok_or(RvError::Overflow)?;
        ally.balance_forca = ally
            .balance_forca
            .checked_sub(net)
            .ok_or(RvError::Overflow)?;
        require!(ally.balance_forca >= ally.rp_reserved, RvError::InsufficientUnreservedBalance);

        emit!(ClaimRPEvent {
            user: ledger.user,
            ally_nft_mint: ledger.ally_nft_mint,
            amount_forca,
            net,
            fee_c,
            tax_d,
            cur_hwm: cur_hwm_u64,
            new_hwm,
            tax_hwm: new_hwm,
        });
        Ok(())
    }

    // Ally consumes PP from user's scoped ledger
    pub fn consume_pp(ctx: Context<ConsumePP>, amount_pp_e6: u64) -> Result<()> {
        require!(amount_pp_e6 > 0, RvError::ZeroAmount);

        let ledger = &mut ctx.accounts.user_ledger;
        require!(ledger.user != Pubkey::default(), RvError::InvalidAuthority);
        require_keys_eq!(ledger.ally_nft_mint, ctx.accounts.ally.nft_mint, RvError::InvalidAuthority);
        require!(ledger.pp_balance >= amount_pp_e6, RvError::InsufficientPP);
        ledger.pp_balance = ledger.pp_balance.checked_sub(amount_pp_e6).ok_or(RvError::Overflow)?;
        ledger.updated_ts = Clock::get()?.unix_timestamp;

        emit!(ConsumePPEvent {
            user: ledger.user,
            ally_nft_mint: ledger.ally_nft_mint,
            amount_pp_e6,
        });
        Ok(())
    }
}

// Accounts
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = pop_admin,
        seeds = [b"vault_state"],
        bump,
        space = 8 + VaultState::LEN,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        seeds = [b"vault_signer"],
        bump,
    )]
    /// CHECK: PDA signer for vault transfers
    pub vault_signer: AccountInfo<'info>,

    pub forca_mint: Account<'info, Mint>,

    #[account(mut)]
    pub pop_admin: Signer<'info>,
    pub econ_admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PopAdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump,
        has_one = pop_admin,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub pop_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct EconAdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump,
        has_one = econ_admin,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub econ_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetMockOracles<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump,
        has_one = econ_admin,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub econ_admin: Signer<'info>,

    #[account(
        init_if_needed,
        payer = econ_admin,
        seeds = [b"mock_oracle_sol"],
        bump,
        space = 8 + MockOracleSolUsd::LEN,
    )]
    pub mock_oracle_sol: Account<'info, MockOracleSolUsd>,

    #[account(
        init_if_needed,
        payer = econ_admin,
        seeds = [b"mock_pool_forca"],
        bump,
        space = 8 + MockPoolForcaSol::LEN,
    )]
    pub mock_pool_forca: Account<'info, MockPoolForcaSol>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPopLevel<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump,
        has_one = pop_admin,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub pop_admin: Signer<'info>,

    /// The user whose POP level is being set
    pub user: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = pop_admin,
        seeds = [b"pop", user.key().as_ref()],
        bump,
        space = 8 + PopProfile::LEN,
    )]
    pub pop_profile: Account<'info, PopProfile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAlly<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump,
        has_one = econ_admin,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub econ_admin: Signer<'info>,

    #[account(constraint = forca_mint.key() == vault_state.forca_mint @ RvError::InvalidMint)]
    pub forca_mint: Account<'info, Mint>,

    #[account(
        seeds = [b"vault_signer"],
        bump = vault_state.vault_signer_bump,
    )]
    /// CHECK: PDA authority for ally vault custodial accounts
    pub vault_signer: AccountInfo<'info>,

    /// Ally identifier NFT mint (any mint acceptable)
    /// CHECK: we only use its key
    pub ally_nft_mint: AccountInfo<'info>,

    /// operations authority (alloc/consume/etc)
    pub ops_authority: Signer<'info>,
    /// withdraw authority (cold key for vault withdrawals / deposits)
    pub withdraw_authority: Signer<'info>,

    #[account(
        mut,
        constraint = ally_treasury_ata.owner == withdraw_authority.key() @ RvError::InvalidAuthority,
        constraint = ally_treasury_ata.mint == forca_mint.key() @ RvError::InvalidMint,
    )]
    pub ally_treasury_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = econ_admin,
        seeds = [b"ally", ally_nft_mint.key().as_ref()],
        bump,
        space = 8 + AllyAccount::LEN,
    )]
    pub ally: Account<'info, AllyAccount>,

    #[account(
        init,
        payer = econ_admin,
        seeds = [b"ally_vault", ally_nft_mint.key().as_ref()],
        bump,
        token::mint = forca_mint,
        token::authority = vault_signer,
    )]
    pub ally_vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AllyDeposit<'info> {
    #[account(mut)]
    pub withdraw_authority: Signer<'info>,

    #[account(mut, has_one = nft_mint, has_one = withdraw_authority)]
    pub ally: Account<'info, AllyAccount>,

    /// CHECK: keep for future validation
    pub nft_mint: AccountInfo<'info>,

    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        constraint = ally_vault_ata.key() == ally.vault_ata @ RvError::InvalidVaultAta,
        constraint = ally_vault_ata.mint == vault_state.forca_mint @ RvError::InvalidMint,
    )]
    pub ally_vault_ata: Account<'info, TokenAccount>,
    #[account(mut, constraint = ally_treasury_ata.key() == ally.treasury_ata @ RvError::InvalidTreasury)]
    pub ally_treasury_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AllyWithdraw<'info> {
        pub withdraw_authority: Signer<'info>,
        #[account(mut, has_one = nft_mint, has_one = withdraw_authority)]
        pub ally: Account<'info, AllyAccount>,

    /// CHECK:
    pub nft_mint: AccountInfo<'info>,

    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        seeds = [b"vault_signer"],
        bump = vault_state.vault_signer_bump,
    )]
    /// CHECK:
        pub vault_signer: AccountInfo<'info>,
        #[account(
            mut,
            constraint = ally_vault_ata.key() == ally.vault_ata @ RvError::InvalidVaultAta,
            constraint = ally_vault_ata.mint == vault_state.forca_mint @ RvError::InvalidMint,
        )]
        pub ally_vault_ata: Account<'info, TokenAccount>,
        #[account(
            mut,
            constraint = ally_treasury_ata.key() == ally.treasury_ata @ RvError::InvalidTreasury,
            constraint = ally_treasury_ata.mint == vault_state.forca_mint @ RvError::InvalidMint,
        )]
        pub ally_treasury_ata: Account<'info, TokenAccount>,
        pub token_program: Program<'info, Token>,
    }

#[derive(Accounts)]
pub struct ConvertToScopedPP<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_ata: Account<'info, TokenAccount>,

    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, has_one = nft_mint)]
    pub ally: Account<'info, AllyAccount>,
    /// CHECK:
    pub nft_mint: AccountInfo<'info>,

    #[account(
        mut,
        constraint = ally_vault_ata.key() == ally.vault_ata @ RvError::InvalidVaultAta,
        constraint = ally_vault_ata.mint == vault_state.forca_mint @ RvError::InvalidMint,
    )]
    pub ally_vault_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"user_ledger", user.key().as_ref(), ally.nft_mint.as_ref()],
        bump,
        space = 8 + UserLedger::LEN,
    )]
    pub user_ledger: Account<'info, UserLedger>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // Oracle proof accounts
    /// CHECK: Pyth price feed account for SOL/USD (unused if use_mock_oracle=true)
    pub pyth_sol_usd_price_feed: AccountInfo<'info>,
    /// CHECK: Canonical Pump/canonical pool account for FORCA/SOL (unused if use_mock_oracle=true)
    pub canonical_pool_forca_sol: AccountInfo<'info>,
    // Mock oracles for local testing (only used if use_mock_oracle=true)
    pub mock_oracle_sol: Account<'info, MockOracleSolUsd>,
    pub mock_pool_forca: Account<'info, MockPoolForcaSol>, 
    // Optional reserve accounts for canonical pool (only checked in production path if provided)
    #[account(
        constraint = pool_forca_reserve.mint == vault_state.forca_mint @ RvError::InvalidMint,
    )]
    pub pool_forca_reserve: Account<'info, TokenAccount>,
    pub pool_sol_reserve: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct SetAllyBenefit<'info> {
    pub ops_authority: Signer<'info>,
    #[account(mut, has_one = ops_authority)]
    pub ally: Account<'info, AllyAccount>,
}

#[derive(Accounts)]
pub struct SetPopParams<'info> {
    pub withdraw_authority: Signer<'info>,
    #[account(mut, has_one = withdraw_authority)]
    pub ally: Account<'info, AllyAccount>,
}

#[derive(Accounts)]
pub struct SetAllyPopEnforcement<'info> {
    pub withdraw_authority: Signer<'info>,
    #[account(mut, has_one = withdraw_authority)]
    pub ally: Account<'info, AllyAccount>,
}

#[derive(Accounts)]
pub struct SetAllyOpsAuthority<'info> {
    pub ops_authority: Signer<'info>,
    #[account(mut, has_one = ops_authority)]
    pub ally: Account<'info, AllyAccount>,
}

#[derive(Accounts)]
pub struct SetAllyWithdrawAuthority<'info> {
    pub withdraw_authority: Signer<'info>,
    #[account(mut, has_one = withdraw_authority)]
    pub ally: Account<'info, AllyAccount>,

    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        constraint = new_treasury_ata.mint == vault_state.forca_mint @ RvError::InvalidMint,
    )]
    pub new_treasury_ata: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AllocateRP<'info> {
    #[account(mut)]
    pub ops_authority: Signer<'info>,
    #[account(mut, has_one = ops_authority)]
    pub ally: Account<'info, AllyAccount>,
    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"user_ledger", user_ledger.user.as_ref(), ally.nft_mint.as_ref()],
        bump = user_ledger.bump
    )]
    pub user_ledger: Account<'info, UserLedger>,

    #[account(
        init_if_needed,
        payer = ops_authority,
        seeds = [b"pop", user_ledger.user.as_ref()],
        bump,
        space = 8 + PopProfile::LEN,
    )]
    pub pop_profile: Account<'info, PopProfile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRP<'info> {
    pub ops_authority: Signer<'info>,
    #[account(mut, has_one = ops_authority)]
    pub ally: Account<'info, AllyAccount>,
    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"user_ledger", user_ledger.user.as_ref(), ally.nft_mint.as_ref()],
        bump = user_ledger.bump
    )]
    pub user_ledger: Account<'info, UserLedger>,
}

#[derive(Accounts)]
pub struct GrantBonusPP<'info> {
    #[account(mut)]
    pub ops_authority: Signer<'info>,
    #[account(mut, has_one = ops_authority)]
    pub ally: Account<'info, AllyAccount>,
    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// The user to receive PP bonus
    pub user: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = ops_authority,
        seeds = [b"user_ledger", user.key().as_ref(), ally.nft_mint.as_ref()],
        bump,
        space = 8 + UserLedger::LEN,
    )]
    pub user_ledger: Account<'info, UserLedger>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRP<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub ally: Box<Account<'info, AllyAccount>>,

    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        seeds = [b"vault_signer"],
        bump = vault_state.vault_signer_bump,
    )]
    /// CHECK:
    pub vault_signer: AccountInfo<'info>,

    #[account(
        mut,
        constraint = ally_vault_ata.key() == ally.vault_ata @ RvError::InvalidVaultAta,
        constraint = ally_vault_ata.mint == vault_state.forca_mint @ RvError::InvalidMint,
    )]
    pub ally_vault_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"user_ledger", user.key().as_ref(), ally.nft_mint.as_ref()],
        bump = user_ledger.bump
    )]
    pub user_ledger: Box<Account<'info, UserLedger>>,

    pub token_program: Program<'info, Token>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"pop", user.key().as_ref()],
        bump,
        space = 8 + PopProfile::LEN,
    )]
    pub pop_profile: Box<Account<'info, PopProfile>>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"claim_guard", user.key().as_ref(), ally.nft_mint.as_ref()],
        bump,
        space = 8 + ClaimGuard::LEN,
    )]
    pub claim_guard: Box<Account<'info, ClaimGuard>>,

    // Oracle proof accounts (used when verify_prices=true and use_mock_oracle=false)
    /// CHECK: Pyth price feed account for SOL/USD (unused if use_mock_oracle=true)
    pub pyth_sol_usd_price_feed: AccountInfo<'info>,
    /// CHECK: Canonical Pump/canonical pool account for FORCA/SOL (unused if use_mock_oracle=true)
    pub canonical_pool_forca_sol: AccountInfo<'info>,
    // Mock oracles for local testing (only used if use_mock_oracle=true)
    pub mock_oracle_sol: Box<Account<'info, MockOracleSolUsd>>,
    pub mock_pool_forca: Box<Account<'info, MockPoolForcaSol>>,
    // Optional reserve accounts for canonical pool (only checked in production path)
    pub pool_forca_reserve: Box<Account<'info, TokenAccount>>,
    pub pool_sol_reserve: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConsumePP<'info> {
    pub ops_authority: Signer<'info>,
    #[account(has_one = ops_authority)]
    pub ally: Account<'info, AllyAccount>,
    #[account(mut,
        seeds = [b"user_ledger", user_ledger.user.as_ref(), ally.nft_mint.as_ref()],
        bump = user_ledger.bump
    )]
    pub user_ledger: Account<'info, UserLedger>,
    #[account(
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,
}

// MigrateLedger account removed (pre-mainnet cleanup)

// State
#[account]
pub struct VaultState {
    pub pop_admin: Pubkey,
    pub econ_admin: Pubkey,
    pub forca_mint: Pubkey,
    pub fee_c_bps: u16,
    pub tax_d_bps: u16,
    pub margin_b_bps: u16,
    pub paused: bool,
    pub vault_signer_bump: u8,
    // PoP + limits
    pub soft_daily_cap_usd_e6: u64,
    pub soft_cooldown_secs: u64,
    pub forca_usd_e6: u64,
    // Oracle config
    pub verify_prices: bool,
    pub oracle_tolerance_bps: u16,
    pub pyth_sol_usd_price_feed: Pubkey,
    pub canonical_pool_forca_sol: Pubkey,
    pub canonical_pool_forca_reserve: Pubkey,
    pub canonical_pool_sol_reserve: Pubkey,
    pub use_mock_oracle: bool,
    pub mock_oracle_locked: bool,
    pub pyth_max_stale_secs: u64,
    pub pyth_max_confidence_bps: u16,
}

impl VaultState {
    pub const LEN: usize = 32 + 32 + 32 + 2 + 2 + 2 + 1 + 1 + 8 + 8 + 8 + 1 + 2 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 2;
}

#[account]
pub struct AllyAccount {
    pub nft_mint: Pubkey,
    pub ops_authority: Pubkey,
    pub withdraw_authority: Pubkey,
    pub treasury_ata: Pubkey,
    pub vault_ata: Pubkey,
    pub role: u8, // AllyRole as u8
    pub balance_forca: u64,
    pub rp_reserved: u64,
    pub benefit_mode: u8, // BenefitMode as u8
    pub benefit_bps: u16, // 0~10000
    pub pop_enforced: bool,
    pub soft_daily_cap_usd_e6: u64,
    pub soft_cooldown_secs: u64,
    pub monthly_claim_limit: u16,
    pub hard_kyc_threshold_usd_e6: u64,
}
impl AllyAccount { pub const LEN: usize = (32 * 5) + 1 + 8 + 8 + 1 + 2 + 1 + 8 + 8 + 2 + 8; }

#[account]
pub struct UserLedger {
    pub user: Pubkey,
    pub ally_nft_mint: Pubkey,
    pub rp_claimable_forca: u64, // simplified: FORCA-equivalent
    pub pp_balance: u64,         // micro-USD (PP)
    pub hwm_claimed: u64,        // current HWM basis (pre-D cumulative)
    pub tax_hwm: u64,            // last taxed HWM baseline
    pub total_claimed_forca: u64,
    pub bump: u8,
    pub created_ts: i64,
    pub updated_ts: i64,
}
impl UserLedger { pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 8 + 8; }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AllyRole { Marketing = 0, Dev = 1, Other = 2 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BenefitMode { None = 0, Discount = 1, BonusPP = 2 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum PauseReason {
    None = 0,
    NonPayment = 1,
    SecurityIncident = 2,
    ComplianceHold = 3,
    MarketAnomaly = 4,
    OpsMaintenance = 5,
}

// -------- Mock oracle accounts (for localnet tests) --------
#[account]
pub struct MockOracleSolUsd {
    pub sol_usd_e6: u64,
    pub expo_i32: i32,
    pub conf_e8: u64,
    pub publish_ts: i64,
}
impl MockOracleSolUsd { pub const LEN: usize = 8 + 4 + 8 + 8; }

#[account]
pub struct MockPoolForcaSol {
    pub forca_per_sol_e6: u64,
    pub reserve_forca_e6: u64,
    pub reserve_sol_e9: u64,
}
impl MockPoolForcaSol { pub const LEN: usize = 8 + 8 + 8; }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PopLevel { Suspicious = 0, Soft = 1, Strong = 2 }

// Events
#[event]
pub struct VaultInitialized { pub forca_mint: Pubkey, pub fee_c_bps: u16, pub tax_d_bps: u16, pub margin_b_bps: u16 }
#[event]
pub struct VaultPauseEvent {
    pub paused: bool,
    pub reason_code: u16,
    pub max_duration_secs: u64,
    pub set_ts: i64,
}
#[event]
pub struct EconAdminUpdated {
    pub old_econ_admin: Pubkey,
    pub new_econ_admin: Pubkey,
    pub set_ts: i64,
}
#[event]
pub struct PopAdminUpdated {
    pub old_pop_admin: Pubkey,
    pub new_pop_admin: Pubkey,
    pub set_ts: i64,
}
#[event]
pub struct AllyRegistered {
    pub ally_nft_mint: Pubkey,
    pub ops_authority: Pubkey,
    pub withdraw_authority: Pubkey,
    pub role: u8,
    pub treasury_ata: Pubkey,
    pub vault_ata: Pubkey,
}
#[event]
pub struct AllyDepositEvent { pub ally_nft_mint: Pubkey, pub amount: u64 }
#[event]
pub struct AllyWithdrawEvent { pub ally_nft_mint: Pubkey, pub amount: u64 }
#[event]
pub struct ConvertToPPEvent {
    pub user: Pubkey,
    pub ally_nft_mint: Pubkey,
    pub amount_forca: u64,
    pub margin_b: u64,
    pub pp_delta: u64,
    pub sol_price_usd_e6: u64,
    pub forca_per_sol_e6: u64,
    pub pyth_price_feed: Pubkey,
    pub canonical_pool: Pubkey,
    pub verify_prices: bool,
    pub oracle_tolerance_bps: u16,
    pub pyth_expo_i32: i32,
    pub pyth_conf_e8: u64,
    pub pyth_publish_ts: i64,
    // New: HWM and benefit debug info
    pub cur_hwm: u64,
    pub new_hwm: u64,
    pub tax_hwm: u64,
    pub benefit_mode: u8,
    pub benefit_bps: u16,
    pub discount_forca: u64,
    pub bonus_pp_e6: u64,
}
#[event]
pub struct AllocateRPEvent { pub user: Pubkey, pub ally_nft_mint: Pubkey, pub forca_equiv_amount: u64 }
#[event]
pub struct CancelRPEvent { pub user: Pubkey, pub ally_nft_mint: Pubkey, pub cancel_amount: u64 }
#[event]
pub struct ClaimRPEvent { pub user: Pubkey, pub ally_nft_mint: Pubkey, pub amount_forca: u64, pub net: u64, pub fee_c: u64, pub tax_d: u64, pub cur_hwm: u64, pub new_hwm: u64, pub tax_hwm: u64 }
#[event]
pub struct ConsumePPEvent { pub user: Pubkey, pub ally_nft_mint: Pubkey, pub amount_pp_e6: u64 }
#[event]
pub struct AllyBenefitSet { pub ally_nft_mint: Pubkey, pub mode: u8, pub bps: u16 }
#[event]
pub struct AllyPopEnforcementSet { pub ally_nft_mint: Pubkey, pub pop_enforced: bool }
#[event]
pub struct PopParamsUpdated {
    pub ally_nft_mint: Pubkey,
    pub old_soft_daily_cap_usd_e6: u64,
    pub old_soft_cooldown_secs: u64,
    pub old_monthly_claim_limit: u16,
    pub old_hard_kyc_threshold_usd_e6: u64,
    pub new_soft_daily_cap_usd_e6: u64,
    pub new_soft_cooldown_secs: u64,
    pub new_monthly_claim_limit: u16,
    pub new_hard_kyc_threshold_usd_e6: u64,
    pub signer: Pubkey,
    pub set_ts: i64,
}
#[event]
pub struct GrantBonusPPEvent { pub user: Pubkey, pub ally_nft_mint: Pubkey, pub amount_pp_e6: u64 }
#[event]
pub struct AllyOpsAuthorityUpdated {
    pub ally_nft_mint: Pubkey,
    pub old_ops_authority: Pubkey,
    pub new_ops_authority: Pubkey,
    pub set_ts: i64,
}
#[event]
pub struct AllyWithdrawAuthorityUpdated {
    pub ally_nft_mint: Pubkey,
    pub old_withdraw_authority: Pubkey,
    pub new_withdraw_authority: Pubkey,
    pub old_treasury_ata: Pubkey,
    pub new_treasury_ata: Pubkey,
    pub set_ts: i64,
}

// Errors
#[error_code]
pub enum RvError {
    #[msg("Operation paused")] Paused,
    #[msg("Overflow")] Overflow,
    #[msg("Invalid bps")] InvalidBps,
    #[msg("Invalid FORCA decimals (must be 6)")] InvalidForcaDecimals,
    #[msg("Invalid token mint")] InvalidMint,
    #[msg("Insufficient ally balance")] InsufficientAllyBalance,
    #[msg("Insufficient vault balance")] InsufficientVaultBalance,
    #[msg("Insufficient unreserved balance")] InsufficientUnreservedBalance,
    #[msg("Insufficient reserved balance")] InsufficientReservedBalance,
    #[msg("Zero amount not allowed")] ZeroAmount,
    #[msg("Invalid quote values")] InvalidQuote,
    #[msg("Insufficient RP allowance")] InsufficientRP,
    #[msg("Insufficient PP balance")] InsufficientPP,
    #[msg("Amount too small after fees")] AmountTooSmallAfterFee,
    #[msg("Invalid treasury token account")] InvalidTreasury,
    #[msg("Invalid vault token account")] InvalidVaultAta,
    #[msg("POP level denies RP allocation")] PopDenied,
    #[msg("Soft POP daily cap exceeded")] SoftDailyCapExceeded,
    #[msg("Cooldown not elapsed")] CooldownNotElapsed,
    #[msg("Soft POP daily cap too low")] PopCapTooLow,
    #[msg("Soft POP cooldown too high")] PopCooldownTooHigh,
    #[msg("Invalid authority")] InvalidAuthority,
    #[msg("Oracle proof accounts missing")] OracleMissing,
    #[msg("Oracle values out of tolerance")] OracleOutOfTolerance,
    #[msg("Oracle key mismatch")] OracleKeyMismatch,
    #[msg("Oracle parsing failed")] OracleParseFailed,
    #[msg("Oracle price is stale")] OracleStale,
    #[msg("Invalid benefit mode value")] InvalidBenefitMode,
    #[msg("verify_prices cannot be disabled once enabled")] VerifyPricesLocked,
    #[msg("Invalid pause reason code")] InvalidPauseReason,
    #[msg("Manual FORCA/USD is only allowed when use_mock_oracle=true")] ManualForcaUsdDisabled,
    #[msg("use_mock_oracle cannot be re-enabled once disabled")] MockOracleLocked,
    #[msg("Monthly claim limit exceeded")] MonthlyClaimLimitExceeded,
    #[msg("KYC required for claim")] KycRequired,
    #[msg("Monthly claim limit too low")] PopMonthlyLimitTooLow,
    #[msg("Monthly claim limit too high")] PopMonthlyLimitTooHigh,
    #[msg("KYC threshold too low")] PopHardCutTooLow,
    #[msg("Oracle confidence interval too wide")] OracleConfidenceTooWide,
}

// PoP profile per user
#[account]
pub struct PopProfile {
    pub user: Pubkey,
    pub level: u8,
    pub bump: u8,
    pub last_set_ts: i64,
}
impl PopProfile { pub const LEN: usize = 32 + 1 + 1 + 8; }

// Per user x ally daily guard
#[account]
pub struct ClaimGuard {
    pub user: Pubkey,
    pub ally_nft_mint: Pubkey,
    pub day: i64,
    pub used_usd_e6: u64,
    pub last_claim_ts: i64,
    pub month_index: i64,
    pub month_claims: u16,
    pub bump: u8,
}
impl ClaimGuard { pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 2 + 1; }
