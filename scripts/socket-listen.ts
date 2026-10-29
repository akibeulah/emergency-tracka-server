/**
 * Prints every realtime event a signed-in user's facility receives.
 *
 *   npm run listen -- <accessToken>
 */
import { io } from 'socket.io-client';

const token = process.argv[2];
if (!token) {
  console.error('usage: npm run listen -- <accessToken>');
  process.exit(1);
}

const socket = io(process.env.API_URL ?? 'http://localhost:3000', { auth: { token }, transports: ['websocket'] });
socket.on('ready', (r) => console.log(`connected — listening for facility ${r.facilityCode}`));
socket.on('auth_error', (e) => {
  console.error(e.message);
  process.exit(1);
});
socket.onAny((event, payload) => console.log(new Date().toISOString(), event, JSON.stringify(payload)));
