# Use an official Node.js runtime as a parent image
FROM node:24-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install production dependencies only — deterministic (from the lockfile) and no
# devDependencies (testcontainers & its transitive protobufjs/grpc/dockerode don't
# belong in the runtime image: smaller + smaller CVE surface).
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY src ./src

# Expose the port the app runs on (if any, though this app is outbound only)
# EXPOSE 8050

# Command to run the application
CMD ["node", "src/index.ts"]
