# 1) Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# 환경변수(VITE_*)는 여기서 “빵굽기” 됩니다.
RUN npm run build

# 2) Runtime stage (serve static by NGINX)
FROM nginx:1.27-alpine
# 커스텀 nginx.conf 복사(아래 2) 참조)
COPY nginx.conf /etc/nginx/conf.d/default.conf
# 정적 파일 복사
COPY --from=build /app/dist /usr/share/nginx/html
# 비루트로 실행(보안 권장)
USER 101
EXPOSE 80