SELECT `ndx`, `name`, `score`, `created`
FROM `rg_st_hallOfFame`
ORDER BY `ndx` DESC
LIMIT :limit
