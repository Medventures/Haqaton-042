FROM node:24-alpine AS build
WORKDIR /project/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY contracts/ /project/contracts/
RUN npm run build
FROM nginx:alpine
LABEL org.opencontainers.image.title="MedRep demo frontend"
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /project/frontend/dist /usr/share/nginx/html
