FROM ubuntu:22.04
RUN apt-get update && apt-get install -y squid
COPY squid.conf /etc/squid/squid.conf
EXPOSE 8080/tcp
CMD ["squid", "-N", "-d", "1"]
