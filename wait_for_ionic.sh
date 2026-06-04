#!/bin/bash
while ! curl -s http://localhost:8100 > /dev/null; do
  echo "Waiting for Ionic server to start..."
  sleep 2
done
echo "Ionic server is up!"
