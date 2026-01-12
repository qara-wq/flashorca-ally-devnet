# Ally 운영 스크립트 가이드 (Superstory 기준)

이 문서는 Superstory Ally가 devnet 운영을 위해 사용할 수 있는 관리 스크립트들의 용도와 실행 방법을 정리합니다.
키 파일은 보안상 **레포에 포함하지 않으며**, 별도 전달된 경로를 사용합니다.

## 포함된 스크립트 목록
다음 스크립트를 `/Users/luke/www/flashorca-ally-devnet/scripts`에 복사해 두었습니다.

- `ally_benefit.ts`: Ally 혜택(할인/보너스PP/없음) 조회 및 설정 (ops 권한)
- `manage_pp.ts`: PP 조회/지급/소모 (ops 권한)
- `manage_rp.ts`: RP 조회/할당/취소 (ops 권한)
- `set_ally_authorities.ts`: ops/withdraw 권한 교체 (현재 권한 필요)
- `set_ally_pop_enforcement.ts`: PoP enforcement on/off (withdraw 권한)
- `withdraw_ally_vault.ts`: Ally vault에서 treasury로 인출 (withdraw 권한)
- `verify_ally_vault.ts`: Ally vault 상태/잔액 검증 (읽기 전용)
- `print_tx_events.ts`: 트랜잭션 로그/이벤트 출력 (디버그용)

## 사전 준비
### 1) 키 파일(레포 외부 보관)
Superstory Ally 기준으로 아래 두 키를 사용합니다.

- Ops 권한 키: `/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json`
- Withdraw 권한 키: `/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json`

레포에 복사하지 말고, 실행 시 경로를 전달합니다.

### 2) IDL/Types 파일
스크립트는 다음 경로를 기대합니다.

- `target/idl/reward_vault.json`
- `target/types/reward_vault.ts`

현재 레포에는 `target/`이 없으므로, 아래 중 하나로 준비하세요.

1) 기존 `flashorca_a2e` 빌드 산출물 복사
```bash
mkdir -p /Users/luke/www/flashorca-ally-devnet/target/idl
mkdir -p /Users/luke/www/flashorca-ally-devnet/target/types
cp /Users/luke/solana/flashorca_a2e/target/idl/reward_vault.json /Users/luke/www/flashorca-ally-devnet/target/idl/
cp /Users/luke/solana/flashorca_a2e/target/types/reward_vault.ts /Users/luke/www/flashorca-ally-devnet/target/types/
```

2) 별도 Anchor 워크스페이스에서 `anchor build`로 생성 후 동일 위치에 복사

> `target/`는 생성 산출물이므로 커밋하지 않는 것을 권장합니다.

### 3) Node 실행 환경
스크립트는 `ts-node`와 `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `bs58` 등을 사용합니다.
이 레포에는 루트 `package.json`이 없으므로, 다음 중 하나를 권장합니다.

- 글로벌 `ts-node` + 필요한 패키지 설치
- 기존 `flashorca_a2e` 레포의 Node 환경을 활용해 실행

## 공통 환경 변수 (예시)
아래는 예시이며, 실제 값은 운영 환경에 맞게 설정하세요.

```
RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=<reward_vault_program_id>
ALLY_NFT_MINT=<ally_nft_mint>
ALLY_OPS_KEYPAIR=/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
ALLY_WITHDRAW_KEYPAIR=/Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

`devnet.env` 같은 파일을 만들어 `--env`로 전달할 수 있습니다.
키 파일 경로가 포함된 환경 파일은 **레포 외부**에 두거나 별도 ignore 처리하세요.

## 스크립트별 사용 방법
아래 예시는 `flashorca-ally-devnet` 루트에서 실행하는 기준입니다.

### 1) Ally 혜택 설정/조회 (ops 권한)
조회:
```bash
ts-node scripts/ally_benefit.ts --action query --ally <ALLY_NFT_MINT>
```

설정(할인 15%):
```bash
ts-node scripts/ally_benefit.ts --action set --mode discount --bps 1500 \
  --ally <ALLY_NFT_MINT> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

### 2) RP 관리 (ops 권한)
조회:
```bash
ts-node scripts/manage_rp.ts --action query --ally <ALLY_NFT_MINT> --user <USER_PUBKEY>
```

할당:
```bash
ts-node scripts/manage_rp.ts --action allocate --amount 5000000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

취소:
```bash
ts-node scripts/manage_rp.ts --action cancel --amount 5000000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

### 3) PP 관리 (ops 권한)
조회:
```bash
ts-node scripts/manage_pp.ts --action query --ally <ALLY_NFT_MINT> --user <USER_PUBKEY>
```

지급:
```bash
ts-node scripts/manage_pp.ts --action grant --amount 1500000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

소모:
```bash
ts-node scripts/manage_pp.ts --action consume --amount 1500000 \
  --ally <ALLY_NFT_MINT> --user <USER_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

### 4) Ally 권한 교체 (ops/withdraw)
Ops 권한 교체:
```bash
ts-node scripts/set_ally_authorities.ts --type ops \
  --ally <ALLY_NFT_MINT> \
  --new <NEW_OPS_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_ops.json
```

Withdraw 권한 교체:
```bash
ts-node scripts/set_ally_authorities.ts --type withdraw \
  --ally <ALLY_NFT_MINT> \
  --new <NEW_WITHDRAW_PUBKEY> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

### 5) PoP Enforcement on/off (withdraw 권한)
조회:
```bash
ts-node scripts/set_ally_pop_enforcement.ts --action query --ally <ALLY_NFT_MINT>
```

설정:
```bash
ts-node scripts/set_ally_pop_enforcement.ts --action set --enforce true \
  --ally <ALLY_NFT_MINT> \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

### 6) Ally Vault 인출 (withdraw 권한)
```bash
ts-node --transpile-only scripts/withdraw_ally_vault.ts \
  --ally <ALLY_NFT_MINT> \
  --amount 1000000 \
  --authority /Users/luke/solana/flashorca_a2e/keys/devnet/ally_superstory_withdraw.json
```

### 7) Ally Vault 검증 (읽기 전용)
특정 Ally만 확인:
```bash
ts-node --transpile-only scripts/verify_ally_vault.ts --ally <ALLY_NFT_MINT>
```

모든 Ally 검사:
```bash
ts-node --transpile-only scripts/verify_ally_vault.ts --all
```

### 8) 트랜잭션 이벤트/로그 확인 (디버그)
```bash
ts-node scripts/print_tx_events.ts <TXID> --rpc https://api.devnet.solana.com
```

## 권장 운영 흐름 (요약)
1) `verify_ally_vault.ts`로 상태 점검  
2) 필요 시 `manage_rp.ts` / `manage_pp.ts`로 보상 조정  
3) 정책 변경은 `ally_benefit.ts` / `set_ally_pop_enforcement.ts`  
4) 권한 교체는 `set_ally_authorities.ts`  
5) 인출은 `withdraw_ally_vault.ts`  

## 보안 메모
- 키 파일은 절대 레포에 커밋하지 않습니다.
- 실행 시 `--authority` 또는 환경 변수로만 전달하세요.
