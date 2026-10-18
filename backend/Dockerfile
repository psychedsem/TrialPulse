FROM node:22-bookworm-slim
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY knowledge_base/ /app/knowledge_base/
USER node
EXPOSE 3001
CMD ["node", "--input-type=module", "-e", "import {app} from './src/app.js'; app.listen(3001, '0.0.0.0');"]
