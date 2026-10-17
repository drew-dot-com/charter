FROM python:3.12.7-slim-bookworm
# NumPy so real numeric work runs. Installed system-wide at build time: the job has no network.
RUN pip install --no-cache-dir --disable-pip-version-check numpy==2.1.3 \
  && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin job
WORKDIR /app
COPY run.py ./
USER job
CMD ["python3", "/app/run.py"]
