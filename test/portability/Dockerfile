FROM node:22-bookworm-slim

WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .

USER node
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "process.exit(0)"
CMD ["npm", "run", "test:portability"]
