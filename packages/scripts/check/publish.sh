#!/usr/bin/env bash

npm run build:clean && npm run bundle && npx publint dist && npx attw --pack dist --profile esm-only
