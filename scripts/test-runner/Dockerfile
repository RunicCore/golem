# golem test runner: the pinned Node/npm baseline, Chromium for the browser
# tier, rsync and flock for the entrypoint. Tier runs are offline; only
# `npm run test:prepare` builds this image and fills the caches.
FROM node:22.15.0-bookworm@sha256:a1f1274dadd49738bcd4cf552af43354bb781a7e9e3bc984cfeedc55aba2ddd8
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FE_DEPS_TEST_CONTAINER=1 \
    FE_DEPS_PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
RUN npm install -g npm@10.9.8 \
 && npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends rsync \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY entrypoint.sh /usr/local/bin/golem-test
LABEL org.exprtlabs.golem-test=1
WORKDIR /cache/work
ENTRYPOINT ["/usr/local/bin/golem-test"]
