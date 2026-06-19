FROM node:20-alpine

RUN apk add --no-cache openssl sqlite python3 make g++

WORKDIR /app

COPY package.json ./

RUN npm install --legacy-peer-deps --include=dev

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

RUN npm run build

RUN mkdir -p /app/prisma-data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=file:/app/prisma-data/prod.db

EXPOSE 3000

CMD ["sh", "-c", "\
  echo '===> Step 1: Syncing database schema...' && \
  npx prisma db push --accept-data-loss && \
  echo '===> Step 2: Regenerating Prisma client against live DB...' && \
  npx prisma generate && \
  echo '===> Step 3: Recompiling server with fresh Prisma client...' && \
  npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs && \
  echo '===> Step 4: Recompiling seed...' && \
  npx esbuild prisma/seed.ts --bundle --platform=node --format=cjs --packages=external --outfile=dist/seed.cjs && \
  echo '===> Step 5: Running seed...' && \
  node dist/seed.cjs && \
  echo '===> Step 6: Starting BANA ERP server...' && \
  node dist/server.cjs \
"]
