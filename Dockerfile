FROM node:18-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Create data directory
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
