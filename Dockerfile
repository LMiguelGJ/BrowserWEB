FROM sameersbn/squid:3.5.27-2
RUN chown -R squid:squid /etc/squid
EXPOSE 3128
