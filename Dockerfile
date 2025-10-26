# Use an official Node.js runtime as a parent image
FROM node:24-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY src ./src

# Expose the port the app runs on (if any, though this app is outbound only)
# EXPOSE 8050

# Command to run the application
CMD ["node", "--experimental-strip-types", "src/index.ts"]
