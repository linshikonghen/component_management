本目录的套件依赖公司内部 BOM / 对账单样例（公开快照里已排除 tests/fixtures/），
所以从 tests/ 移到这里：公开版 run_all 只扫 tests/*.js（不递归），不会运行它们。
要跑完整回归请使用本地开发仓库：node tests/run_all.js
