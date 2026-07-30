FROM node:22-bookworm-slim

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

CMD ["npm", "run", "test:portability"]
