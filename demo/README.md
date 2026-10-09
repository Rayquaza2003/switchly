# Demo: one shop, three branches, three instances

`shop/` is a small web shop in its own git repository. Each branch is deployed as its own Docker container, and each container belongs to one Switchly environment.

| Instance | Branch | Switchly environment | Flag its code checks |
| --- | --- | --- | --- |
| http://localhost:4001 | `main` | production | `free-shipping-banner` |
| http://localhost:4002 | `feature/new-checkout` | staging | `free-shipping-banner`, `new-checkout` |
| http://localhost:4003 | `feature/recommendations` | development | `free-shipping-banner`, `recommendations` |

## Start

```sh
colima start              # Docker VM, if not running
npm run dev               # in the Switchly folder: API on :3000, dashboard on :5173
node demo/setup.mjs       # once: creates project "Corner Coffee shop", saves SDK keys to demo/instances.env
demo/deploy.sh            # builds and starts all three instances
```

## Deploy from the dashboard

Project "Corner Coffee shop" has a **Deploy** tab: source branches on the left, one card per instance on the right. Pick a branch in an instance's card and press Deploy. The card shows progress, the build log under "Details", what is running now, and a "Roll back to …" button that redeploys the previous good commit.

`node demo/setup.mjs` is what enables the tab: it writes `server/deploy.config.json`, which tells the Switchly server where the shop repository is and which port and SDK key each instance uses.

From a terminal instead: `demo/deploy.sh <branch> <environment> <port>`, for example `demo/deploy.sh feature/new-checkout production 4001` to "release" the checkout branch to production with its flag still off.

Stop everything: `docker rm -f shop-production shop-staging shop-development`, then `colima stop`.

## Try

Dashboard login `demo@example.com`, project "Corner Coffee shop". Keep a shop tab open beside the dashboard; pages update without reload.

- Switch on `new-checkout` in staging: :4002 swaps its checkout button. Switch it on in production: :4001 does not change, because `main` has no code for it yet.
- Target one shopper: add `asha` under selected users, share 0 %. Pick shoppers in the shop's "Shopping as" menu.
- Rule: `country is IN`, 100 %. Shoppers asha and dara get it, ben and chen do not.
- Percentage: set 50 %, click "New random visitor" a few times.
- Automatic switch-off: on :4002 start a stepped rollout with a failure limit of 10 % after 20 reports, tick "Make the new checkout fail", click "Place 20 test orders". The flag turns itself off within about 15 seconds.
