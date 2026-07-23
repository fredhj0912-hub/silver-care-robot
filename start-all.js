const { spawn } = require('child_process');
const path = require('path');

console.log('Starting Silver Care Companion Robot Prototype services...');

const backendDir = path.join(__dirname, 'backend');
const frontendDir = path.join(__dirname, 'frontend');

// Helper to pipe process output
function pipeOutput(child, name) {
  child.stdout.on('data', (data) => {
    console.log(`[${name}] ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    console.error(`[${name} ERROR] ${data.toString().trim()}`);
  });
}

// Start Backend
console.log('Launching backend on port 3001...');
const backendProcess = spawn('npm', ['start'], { 
  cwd: backendDir, 
  shell: true 
});
pipeOutput(backendProcess, 'Backend');

// Start Frontend
console.log('Launching frontend on port 5173...');
const frontendProcess = spawn('npm', ['run', 'dev'], { 
  cwd: frontendDir, 
  shell: true 
});
pipeOutput(frontendProcess, 'Frontend');

// Handle exit
function cleanup() {
  console.log('\nShutting down services...');
  backendProcess.kill();
  frontendProcess.kill();
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

backendProcess.on('exit', (code) => {
  console.log(`Backend process exited with code ${code}`);
  cleanup();
});

frontendProcess.on('exit', (code) => {
  console.log(`Frontend process exited with code ${code}`);
  cleanup();
});
