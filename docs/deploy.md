# Deploy: ally-devnet.flashorca.com

## 1) Build frontend bundle
```bash
cd web
npm install
npm run build:devnet
```

Note:
- `build:devnet` outputs to `static/solana_mwa-devnet`. The app now auto-detects this folder.
- If you want the stable path `static/solana_mwa`, run `npm run build:production` (env is already devnet), or set `BUILD_OUT_DIR=/Users/luke/www/flashorca-ally-devnet/static/solana_mwa` before building.

## 2) Build + push image
```bash
# example tag
IMAGE=cr.qara.kr/qara/flashorca-ally-devnet-app:$(git rev-parse --short HEAD)

docker build -t "$IMAGE" .
docker push "$IMAGE"

or

docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$IMAGE" --push .
```

Update `k8s/ally-devnet-deployment.yaml` with the image tag.

## 3) Apply k8s manifests
```bash
kubectl apply -f k8s/ally-devnet-secrets.example.yaml
kubectl apply -f k8s/ally-devnet-tls.yaml
kubectl apply -f k8s/ally-devnet-deployment.yaml
kubectl apply -f k8s/ally-devnet-ingress.yaml

or

kubectl -n nexus-ai rollout restart deployment/flashorca-ally-devnet-app
```

## 4) DNS
Point `ally-devnet.flashorca.com` to the ingress load balancer.

## 5) Verify
```bash
curl -i https://ally-devnet.flashorca.com/healthz
```
