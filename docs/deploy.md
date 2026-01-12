# Deploy: ally-devnet.flashorca.com

## 1) Build frontend bundle
```bash
cd web
npm install
npm run build:devnet
```

## 2) Build + push image
```bash
# example tag
IMAGE=cr.qara.kr/qara/flashorca-ally-devnet-app:$(git rev-parse --short HEAD)

docker build -t "$IMAGE" .
docker push "$IMAGE"

or

docker buildx build --platform linux/amd64,linux/arm64 \
  -t cr.qara.kr/qara/flashorca-ally-devnet-app:latest --push .
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
