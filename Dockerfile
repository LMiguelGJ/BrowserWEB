FROM dannydirect/tinyproxy:latest

EXPOSE 8888

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf", "-a", "ANY"]
