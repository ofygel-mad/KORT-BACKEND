-- Remove all letter-based sizes (XS, S, M, L, XL, XXL, XXXL, etc)
-- Keep only numeric sizes
DELETE FROM "chapan_catalog_sizes"
WHERE name ~ '[A-Za-z]'
   OR name NOT LIKE '%[0-9]%';
