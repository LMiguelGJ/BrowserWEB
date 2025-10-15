FROM jlesage/firefox

ENV USER_ID=0
ENV GROUP_ID=0
EXPOSE 5800

CMD ["/init"]
