# fe-deps test runner: the pinned Node/npm baseline, Chromium for the browser
# tier, rsync and flock for the entrypoint. Tier runs are offline; only
# `npm run test:prepare` builds this image and fills the caches.
FROM node:22.12.0-bookworm@sha256:0e910f435308c36ea60b4cfd7b80208044d77a074d16b768a81901ce938a62dc
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FE_DEPS_TEST_CONTAINER=1 \
    FE_DEPS_PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
RUN npm install -g npm@10.9.8 \
 && npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends rsync \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY entrypoint.sh /usr/local/bin/fe-deps-test
LABEL org.exprtlabs.fe-deps-test=1
WORKDIR /cache/work
ENTRYPOINT ["/usr/local/bin/fe-deps-test"]
