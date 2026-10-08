/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:33001' },
};
