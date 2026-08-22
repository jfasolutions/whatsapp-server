# Dockerfile para Node.js + MySQL com persistência
FROM node:18 AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:18-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/.env.example ./
RUN npm install --omit=dev

# Instala MySQL
RUN apt-get update && \
    apt-get install -y mysql-server && \
    rm -rf /var/lib/apt/lists/*

# Configura variáveis do MySQL
ENV MYSQL_ROOT_PASSWORD=root
ENV MYSQL_DATABASE=appdb
ENV MYSQL_USER=appuser
ENV MYSQL_PASSWORD=apppass

# Cria diretório para persistência
VOLUME ["/var/lib/mysql"]

# Expondo portas
EXPOSE 3000 3306

# Script de inicialização: inicia MySQL, espera subir, depois inicia o app
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
CMD ["/docker-entrypoint.sh"]
