FROM zenika/alpine-chrome:124-with-puppeteer

ARG WWEBJS_REF=""
ARG APP_BUILD_VERSION=""
ARG APP_RUNTIME_NAME=""
ARG APP_PORT=""

ADD app /workspace/app
ADD homeassistant /workspace/homeassistant
COPY docker/entrypoint.sh /workspace/docker/entrypoint.sh
WORKDIR /workspace
USER root
COPY package*.json .
RUN chmod +x /workspace/docker/entrypoint.sh && \
    npm_with_retries() { \
      local n=0; \
      until npm "$@"; do \
        n=$((n+1)); \
        [ $n -ge 3 ] && echo "npm $* failed after $n retries" >&2 && return 1; \
        echo "npm $* failed (attempt $n), retrying in $((n*5))s..." >&2; \
        sleep $((n*5)); \
      done; \
    } && \
    npm_with_retries install && \
    if [ -n "$WWEBJS_REF" ]; then npm_with_retries install --no-save "github:pedroslopez/whatsapp-web.js#$WWEBJS_REF"; fi

ENV HA_CUSTOM_COMPONENTS_PATH=/homeassistant/custom_components
ENV WWEBJS_BUILD_REF=${WWEBJS_REF}
ENV APP_BUILD_VERSION=${APP_BUILD_VERSION}
ENV APP_RUNTIME_NAME=${APP_RUNTIME_NAME}
ENV APP_PORT=${APP_PORT}
EXPOSE 3000
EXPOSE 3001

VOLUME /data

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
