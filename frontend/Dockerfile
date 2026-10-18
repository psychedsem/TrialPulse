FROM node:22-bookworm-slim
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN chown -R node:node /app/frontend
USER node
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
