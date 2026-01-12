# Ally Admin Scripts Guide (Superstory, devnet)

This document describes the admin scripts Superstory uses for devnet operations.
Key files are security-sensitive and are not committed to the repo. Pass them via paths when running scripts.

## Included scripts
These scripts live under `/Users/luke/www/flashorca-ally-devnet/scripts`.

- `ally_benefit.ts`: Query or set ally benefit (discount/bonus/none) (ops authority)
- `manage_pp.ts`: Query/grant/consume PP (ops authority)
- `manage_rp.ts`: Query/allocate/cancel RP (ops authority)
- `set_ally_authorities.ts`: Rotate ops/withdraw authority (current authority required)
- `set_ally_pop_enforcement.ts`: Toggle PoP enforcement (withdraw authority)
- `withdraw_ally_vault.ts`: Withdraw from ally vault to treasury (withdraw authority)
- `verify_ally_vault.ts`: Verify ally vault balances (read-only)
- `print_tx_events.ts`: Pretty-print tx logs/events (debug)

## Prerequisites
### 1) Key files (kept outside the repo)
For Superstory, use these two keys:

- Ops key: `/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json`
- Withdraw key: `/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json`

Do not copy them into the repo. Pass their paths when running scripts.

### 2) IDL/Types files
These scripts expect:

- `target/idl/reward_vault.json`
- `target/types/reward_vault.ts`

You already copied these into the repo, so you can skip this step. If you ever need to refresh them:

1) Copy from `flashorca_a2e` build output
```bash
mkdir -p /Users/luke/www/flashorca-ally-devnet/target/idl
mkdir -p /Users/luke/www/flashorca-ally-devnet/target/types
cp /Users/luke/solana/flashorca_a2e/target/idl/reward_vault.json /Users/luke/www/flashorca-ally-devnet/target/idl/
cp /Users/luke/solana/flashorca_a2e/target/types/reward_vault.ts /Users/luke/www/flashorca-ally-devnet/target/types/
```

2) Or build in an Anchor workspace and copy to the same paths.

Note: `target/` is generated output. Decide whether you want it committed or ignored.

### 3) Node runtime
These scripts require `ts-node`, `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, and `bs58`.
There is no root `package.json`, so use one of these approaches:

- Global `ts-node` and required packages
- Reuse the Node environment from `flashorca_a2e`

## Common env vars (example)
Adjust these to your environment:

```
RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=<reward_vault_program_id>
ALLY_NFT_MINT=<ally_nft_mint>
ALLY_OPS_KEYPAIR=/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
ALLY_WITHDRAW_KEYPAIR=/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

You can put them in a `devnet.env` file and pass `--env`.
If the file contains key paths, keep it outside the repo or ignore it.

## Script usage
All examples assume you run from the `flashorca-ally-devnet` root.

### 1) Ally benefit (ops authority)
Query:
```bash
ts-node scripts/ally_benefit.ts --action query --ally <ALLY_NFT_MINT>
```

Set (15% discount):
```bash
ts-node scripts/ally_benefit.ts --action set --mode discount --bps 1500 \
  --ally <ALLY_NFT_MINT> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

### 2) RP management (ops authority)
Query:
```bash
ts-node scripts/manage_rp.ts --action query --ally <ALLY_NFT_MINT> --user <USER_PUBKEY>
```

Allocate:
```bash
ts-node scripts/manage_rp.ts --action allocate --amount 5000000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

Cancel:
```bash
ts-node scripts/manage_rp.ts --action cancel --amount 5000000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

### 3) PP management (ops authority)
Query:
```bash
ts-node scripts/manage_pp.ts --action query --ally <ALLY_NFT_MINT> --user <USER_PUBKEY>
```

Grant:
```bash
ts-node scripts/manage_pp.ts --action grant --amount 1500000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

Consume:
```bash
ts-node scripts/manage_pp.ts --action consume --amount 1500000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

### 4) Rotate ally authorities (ops/withdraw)
Rotate ops authority:
```bash
ts-node scripts/set_ally_authorities.ts --type ops \
  --ally <ALLY_NFT_MINT> \
  --new <NEW_OPS_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

Rotate withdraw authority:
```bash
ts-node scripts/set_ally_authorities.ts --type withdraw \
  --ally <ALLY_NFT_MINT> \
  --new <NEW_WITHDRAW_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

### 5) PoP enforcement on/off (withdraw authority)
Query:
```bash
ts-node scripts/set_ally_pop_enforcement.ts --action query --ally <ALLY_NFT_MINT>
```

Set:
```bash
ts-node scripts/set_ally_pop_enforcement.ts --action set --enforce true \
  --ally <ALLY_NFT_MINT> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

### 6) Withdraw from ally vault (withdraw authority)
```bash
ts-node --transpile-only scripts/withdraw_ally_vault.ts \
  --ally <ALLY_NFT_MINT> \
  --amount 1000000 \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

### 7) Verify ally vault (read-only)
Single ally:
```bash
ts-node --transpile-only scripts/verify_ally_vault.ts --ally <ALLY_NFT_MINT>
```

All allies:
```bash
ts-node --transpile-only scripts/verify_ally_vault.ts --all
```

### 8) Print tx events/logs (debug)
```bash
ts-node scripts/print_tx_events.ts <TXID> --rpc https://api.devnet.solana.com
```

## Recommended ops flow
1) Check state with `verify_ally_vault.ts`
2) Adjust rewards with `manage_rp.ts` / `manage_pp.ts` if needed
3) Change policy via `ally_benefit.ts` / `set_ally_pop_enforcement.ts`
4) Rotate authorities with `set_ally_authorities.ts`
5) Withdraw with `withdraw_ally_vault.ts`

## Security notes
- Never commit key files to the repo.
- Pass keys via `--authority` or environment variables only.
