FROM node:18-alpine AS build

WORKDIR /app

# The Shopify app client_id, baked into index.html by Vite. It is a public
# identifier, not a secret - it appears in the page source either way.
ARG VITE_SHOPIFY_API_KEY=""
ENV VITE_SHOPIFY_API_KEY=$VITE_SHOPIFY_API_KEY

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
