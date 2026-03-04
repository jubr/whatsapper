FROM zenika/alpine-chrome:124-with-puppeteer

ADD app /workspace/app
ADD homeassistant /workspace/homeassistant
COPY docker/entrypoint.sh /workspace/docker/entrypoint.sh
WORKDIR /workspace
USER root
COPY package*.json .
RUN chmod +x /workspace/docker/entrypoint.sh && npm install

ENV HA_CUSTOM_COMPONENTS_PATH=/ha-custom-components
EXPOSE 3000

VOLUME /data
VOLUME /ha-custom-components

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
