FROM node:22-alpine AS build
WORKDIR /src
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
ARG VITE_MQTT_PASSWORD
ENV VITE_MQTT_URL=same-origin VITE_MQTT_USERNAME=player
RUN npm run build
FROM nginx:alpine
COPY infrastructure/online/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
