#!/bin/bash
set -e

# Inicia o MySQL em background
mysqld &

# Aguarda o MySQL subir
until mysqladmin ping -h "127.0.0.1" --silent; do
    echo 'Aguardando MySQL...'
    sleep 2
done

# Executa migrations do Prisma (se necessário)
if [ -f "node_modules/.bin/prisma" ]; then
    npx prisma migrate deploy || true
fi

# Inicia o app Node.js
node dist/index.js
