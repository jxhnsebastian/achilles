## Instance setup
```
pnpm build
pm2 start ecosystem.config.js
```

```
pm2 logs
pm2 list
pm2 delete all
pm2 logs <service-name> --lines 50
```