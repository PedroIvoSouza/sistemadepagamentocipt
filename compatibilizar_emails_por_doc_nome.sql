.bail on
PRAGMA foreign_keys=OFF;
BEGIN;

-- =======================================================================
-- 1) Arquivo CSV esperado: todos_clientes_emails.csv
--    Colunas (ordem exata): documento,email,contato,cliente
--    -> Renomeie seu CSV ou edite a linha .import abaixo conforme necessário.
-- =======================================================================
DROP TABLE IF EXISTS temp.tmp_csv;
CREATE TEMP TABLE tmp_csv(
  documento TEXT,
  email     TEXT,
  contato   TEXT,
  cliente   TEXT
);

.mode csv
.import todos_clientes_emails.csv tmp_csv

-- remove possível linha de cabeçalho
DELETE FROM tmp_csv
WHERE LOWER(TRIM(documento)) IN ('documento','cnpj','cpf')
   OR LOWER(TRIM(email))     = 'email';

-- Normaliza mapeamento
DROP TABLE IF EXISTS temp.tmp_norm;
CREATE TEMP TABLE tmp_norm AS
SELECT
  TRIM(cliente) AS cliente,
  -- normaliza documento vindo da planilha
  REPLACE(REPLACE(REPLACE(TRIM(documento),'.',''),'/',''),'-','') AS documento_norm,
  CASE
    WHEN LENGTH(REPLACE(REPLACE(REPLACE(TRIM(documento),'.',''),'/',''),'-',''))=14
    THEN SUBSTR(REPLACE(REPLACE(REPLACE(TRIM(documento),'.',''),'/',''),'-',''),1,8)
    ELSE NULL
  END AS documento_raiz,
  -- higieniza email (minúsculas + separadores comuns)
  LOWER(TRIM(REPLACE(REPLACE(email,' / ','; '),',','; '))) AS email_norm,
  TRIM(contato) AS contato_norm
FROM tmp_csv;

-- =======================================================================
-- 2) Garantir normalização mínima no banco (se ainda faltar)
-- =======================================================================
UPDATE Clientes_Eventos
SET documento_norm = REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','')
WHERE documento IS NOT NULL AND (documento_norm IS NULL OR TRIM(documento_norm)='');

UPDATE Clientes_Eventos
SET documento_raiz = SUBSTR(documento_norm,1,8)
WHERE documento_norm IS NOT NULL
  AND LENGTH(documento_norm)=14
  AND (documento_raiz IS NULL OR TRIM(documento_raiz)='');

-- =======================================================================
-- 3) Atualização por DOCUMENTO (match exato em documento_norm)
-- =======================================================================
UPDATE Clientes_Eventos AS c
SET email = n.email_norm
FROM tmp_norm n
WHERE n.documento_norm IS NOT NULL AND n.documento_norm<>''
  AND (c.documento_norm = n.documento_norm
       OR REPLACE(REPLACE(REPLACE(c.documento,'.',''),'/',''),'-','') = n.documento_norm)
  AND n.email_norm IS NOT NULL AND TRIM(n.email_norm)<>''
  AND (c.email IS NULL OR TRIM(c.email)='' OR c.email LIKE 'sem.email.%@importado.placeholder');

UPDATE Clientes_Eventos AS c
SET nome_responsavel = n.contato_norm
FROM tmp_norm n
WHERE n.documento_norm IS NOT NULL AND n.documento_norm<>''
  AND (c.documento_norm = n.documento_norm
       OR REPLACE(REPLACE(REPLACE(c.documento,'.',''),'/',''),'-','') = n.documento_norm)
  AND n.contato_norm IS NOT NULL AND TRIM(n.contato_norm)<>''
  AND (c.nome_responsavel IS NULL OR TRIM(c.nome_responsavel)='');

-- =======================================================================
-- 4) Fallback por DOCUMENTO_RAIZ, apenas quando único no CSV
--    (evita conflito de vários CNPJs com o mesmo raiz e e-mails diferentes)
-- =======================================================================
WITH uniq AS (
  SELECT documento_raiz,
         MIN(email_norm) AS email_norm,
         COUNT(DISTINCT email_norm) AS cnt
  FROM tmp_norm
  WHERE documento_raiz IS NOT NULL AND documento_raiz <> ''
        AND email_norm IS NOT NULL AND TRIM(email_norm)<>''
  GROUP BY documento_raiz
  HAVING cnt = 1
)
UPDATE Clientes_Eventos AS c
SET email = u.email_norm
FROM uniq u
WHERE c.email LIKE 'sem.email.%@importado.placeholder'
  AND c.documento_raiz = u.documento_raiz;

-- contato via raiz único
WITH uniqc AS (
  SELECT documento_raiz,
         MIN(contato_norm) AS contato_norm,
         COUNT(DISTINCT contato_norm) AS cnt
  FROM tmp_norm
  WHERE documento_raiz IS NOT NULL AND documento_raiz <> ''
        AND contato_norm IS NOT NULL AND TRIM(contato_norm)<>''
  GROUP BY documento_raiz
  HAVING cnt = 1
)
UPDATE Clientes_Eventos AS c
SET nome_responsavel = u.contato_norm
FROM uniqc u
WHERE (c.nome_responsavel IS NULL OR TRIM(c.nome_responsavel)='')
  AND c.documento_raiz = u.documento_raiz;

-- =======================================================================
-- 5) Fallback por NOME exato (casos sem documento)
-- =======================================================================
UPDATE Clientes_Eventos AS c
SET email = n.email_norm
FROM tmp_norm n
WHERE UPPER(TRIM(c.nome_razao_social)) = UPPER(TRIM(n.cliente))
  AND n.email_norm IS NOT NULL AND TRIM(n.email_norm)<>''
  AND (c.email IS NULL OR TRIM(c.email)='' OR c.email LIKE 'sem.email.%@importado.placeholder');

UPDATE Clientes_Eventos AS c
SET nome_responsavel = n.contato_norm
FROM tmp_norm n
WHERE UPPER(TRIM(c.nome_razao_social)) = UPPER(TRIM(n.cliente))
  AND n.contato_norm IS NOT NULL AND TRIM(n.contato_norm)<>''
  AND (c.nome_responsavel IS NULL OR TRIM(c.nome_responsavel)='');

COMMIT;

-- =======================================================================
-- 6) Relatórios
-- =======================================================================
.headers on
.mode column

.print ''
.print '== Pós-compatibilização (doc/doc_raiz/nome) =='
SELECT 
  COUNT(*) AS total_clientes,
  SUM(CASE WHEN email IS NULL OR TRIM(email)='' THEN 1 ELSE 0 END) AS emails_vazios,
  SUM(CASE WHEN email LIKE 'sem.email.%@importado.placeholder' THEN 1 ELSE 0 END) AS placeholders
FROM Clientes_Eventos;

.print ''
.print '== Restantes com placeholder (se houver) =='
SELECT nome_razao_social AS cliente,
       COALESCE(documento_norm,documento) AS documento,
       nome_responsavel AS contato,
       email
FROM Clientes_Eventos
WHERE email LIKE 'sem.email.%@importado.placeholder'
ORDER BY cliente;

.print ''
.print '== Amostra (30) atualizados =='
SELECT nome_razao_social AS cliente,
       COALESCE(documento_norm,documento) AS documento,
       nome_responsavel AS contato,
       email
FROM Clientes_Eventos
WHERE email NOT LIKE 'sem.email.%@importado.placeholder'
ORDER BY cliente
LIMIT 30;
