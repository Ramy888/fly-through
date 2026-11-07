# The sandbox runner: Docker CLI + Python, talking to the host's Docker daemon. Nothing else.
FROM docker:29-cli
RUN apk add --no-cache python3
WORKDIR /sandbox
COPY runner.py ./
CMD ["python3", "/sandbox/runner.py"]
