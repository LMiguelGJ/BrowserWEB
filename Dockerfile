FROM serjs/go-socks5-proxy:latest
ENV REQUIRE_AUTH=false
ENV PROXY_PORT=1080
EXPOSE 1080
CMD ["go-socks5-proxy"]
