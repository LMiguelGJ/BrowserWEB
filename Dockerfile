FROM b4tman/squid-ssl-bump:latest

EXPOSE 8080

CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
