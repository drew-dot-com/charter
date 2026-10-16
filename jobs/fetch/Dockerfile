FROM mcr.microsoft.com/playwright:v1.49.0-noble
WORKDIR /app
# The base image ships the browsers, not the npm package. Pin the package to the
# same version so the two match.
RUN npm install --no-save --no-audit --no-fund playwright@1.49.0
COPY guard.mjs fetch.mjs ./
USER pwuser
CMD ["node", "/app/fetch.mjs"]
