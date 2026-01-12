# FlashOrca Ally Devnet

Reward Vault only service for `ally-devnet.flashorca.com`.

## Structure
- `app.py`: Flask backend (serves template + `/rpc` proxy + `/api/env`).
- `templates/ally_devnet_index.html`: Minimal page that mounts the React Reward Vault module.
- `web/`: Vite + React source for Reward Vault UI.
- `static/solana_mwa/`: Build output (`wallet.js`, `wallet.css`).
- `server/siws.py`: RPC proxy (and optional SIWS endpoints).
- `programs/reward_vault/src/lib.rs`: On-chain program reference.

## Local dev

Backend:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
RPC_URL=https://api.devnet.solana.com \
FLASHORCA_PUBLIC_ORIGIN=http://localhost:8000 \
python app.py
```

Frontend (dev server):
```bash
cd web
npm install
npm run dev
```

Frontend build (static bundle):
```bash
cd web
npm run build:devnet
```

## Environment
Required:
- `RPC_URL` or `RPC_UPSTREAM`

Recommended:
- `FLASHORCA_PUBLIC_ORIGIN` (e.g. `https://ally-devnet.flashorca.com`)
- `RPC_METHOD_ALLOWLIST` (optional hardening for `/rpc`)

## Docker
```bash
docker build -t flashorca-ally-devnet:local .
```

## K8s
See `k8s/` for deployment/ingress manifests.
