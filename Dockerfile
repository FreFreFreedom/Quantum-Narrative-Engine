FROM node:22-alpine
WORKDIR /app
COPY queue-server/package*.json ./
RUN npm install
COPY queue-server/ ./
EXPOSE 3000
CMD ["npm", "start"]