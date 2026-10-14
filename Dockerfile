FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV HEADLESS=true
CMD ["node", "server.js"]