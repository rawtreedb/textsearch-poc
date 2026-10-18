FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MODELS_DIR=/app/models ALLOW_REMOTE_MODELS=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN node --input-type=module -e "import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers'; env.cacheDir = '/app/models'; const model = 'Xenova/clip-vit-base-patch32'; await AutoTokenizer.from_pretrained(model); await CLIPTextModelWithProjection.from_pretrained(model, { dtype: 'fp32' });"
RUN node --input-type=module -e "import { pipeline, env } from '@huggingface/transformers'; env.cacheDir = '/app/models'; await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });"
COPY server.mjs ./
COPY lib ./lib
COPY datasets ./datasets
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
