.bail on
PRAGMA foreign_keys=OFF;
BEGIN;

-- Atualiza e-mails e contato vindos da planilha (compatibilização completa)
-- Atualiza email quando vier na planilha; contato só quando vazio no banco.

UPDATE Clientes_Eventos
SET email = LOWER(TRIM('auditorios@medgrupo.com.br'))
WHERE (documento_norm = '17654804000107' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17654804000107');
UPDATE Clientes_Eventos
SET nome_responsavel = '(21) 99891-0910 / (21) 98209-3040'
WHERE (documento_norm = '17654804000107' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17654804000107')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('souandreluis@gmail.com'))
WHERE (documento_norm = '00300771339' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '00300771339');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 98822-7274'
WHERE (documento_norm = '00300771339' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '00300771339')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('albuquerquedelucena@gmail.com'))
WHERE (documento_norm = '14149596000109' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '14149596000109');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 98187-0017'
WHERE (documento_norm = '14149596000109' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '14149596000109')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('christianomarinho3@gmail.com'))
WHERE (documento_norm = '37922328000175' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37922328000175');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9621-5688'
WHERE (documento_norm = '37922328000175' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37922328000175')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('cepec.al@hotmail.com'))
WHERE (documento_norm = '17361388000159' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17361388000159');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8862-7871'
WHERE (documento_norm = '17361388000159' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17361388000159')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('sec.lacosdosaber@gmail.com'))
WHERE (documento_norm = '35157090000103' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '35157090000103');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8159-1974'
WHERE (documento_norm = '35157090000103' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '35157090000103')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('producaoga.al@gmail.com'))
WHERE (documento_norm = '61024498000117' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '61024498000117');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9800-9182'
WHERE (documento_norm = '61024498000117' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '61024498000117')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('cleovaz@systemidiomas.com.br'))
WHERE (documento_norm = '09338997000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '09338997000169');
UPDATE Clientes_Eventos
SET nome_responsavel = '(21) 9 8001-1166'
WHERE (documento_norm = '09338997000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '09338997000169')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('carinapreis@hotmail.com'))
WHERE (documento_norm = '04489388632' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '04489388632');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9969-0692'
WHERE (documento_norm = '04489388632' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '04489388632')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('mariaduarte.mgconfeccoes@gmail.com'))
WHERE (documento_norm = '12416933000143' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '12416933000143');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8188-7089'
WHERE (documento_norm = '12416933000143' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '12416933000143')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('anny_gabrielle1@outlook.com'))
WHERE (documento_norm = '07800488000180' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '07800488000180');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9956-2540 (Anny)'
WHERE (documento_norm = '07800488000180' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '07800488000180')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('beatrizcavalcantecmf@gmail.com'))
WHERE (documento_norm = '13063572000161' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13063572000161');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 99837-2830'
WHERE (documento_norm = '13063572000161' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13063572000161')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('admoficinadavida@hotmail.com'))
WHERE (documento_norm = '31443184000198' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '31443184000198');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9101-8892'
WHERE (documento_norm = '31443184000198' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '31443184000198')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('educ.sinai@hotmail.com'))
WHERE (documento_norm = '03879039000119' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '03879039000119');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8816-2316'
WHERE (documento_norm = '03879039000119' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '03879039000119')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('colegiomanoelcandido23@gmail.com'))
WHERE (documento_norm = '45455018000189' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '45455018000189');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8857-6852'
WHERE (documento_norm = '45455018000189' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '45455018000189')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('rafinha_goncalves@hotmail.com'))
WHERE (documento_norm = '23077818000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '23077818000108');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9309-4488'
WHERE (documento_norm = '23077818000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '23077818000108')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('agendamento@multieventos.com'))
WHERE (documento_norm = '02890163000112' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '02890163000112');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8831-7198'
WHERE (documento_norm = '02890163000112' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '02890163000112')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('colegioiepoficial@gmail.com'))
WHERE (documento_norm = '34116804000172' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '34116804000172');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9178-4460'
WHERE (documento_norm = '34116804000172' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '34116804000172')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('direcao@littletown.net.br'))
WHERE (documento_norm = '32088484000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '32088484000169');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9990-9717'
WHERE (documento_norm = '32088484000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '32088484000169')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('attoartes@gmail.com'))
WHERE (documento_norm = '37992577000137' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37992577000137');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9193-7382'
WHERE (documento_norm = '37992577000137' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37992577000137')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('williams-patrik@hotmail.com'))
WHERE (documento_norm = '33191527000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '33191527000108');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8831-7198'
WHERE (documento_norm = '33191527000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '33191527000108')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('produtorakratendimento@gmail.com'))
WHERE (documento_norm = '13181652000111' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13181652000111');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 8868-3745'
WHERE (documento_norm = '13181652000111' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13181652000111')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('casademusicavillalobos@hotmail.com'))
WHERE (documento_norm = '15629906000147' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '15629906000147');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9361-3777'
WHERE (documento_norm = '15629906000147' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '15629906000147')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('allegrostudiodedancaa@gmail.com'))
WHERE (documento_norm = '49453700000120' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '49453700000120');
UPDATE Clientes_Eventos
SET nome_responsavel = '(82) 9 9109-2002'
WHERE (documento_norm = '49453700000120' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '49453700000120')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');
UPDATE Clientes_Eventos
SET email = LOWER(TRIM('ecostreinamentosecursos@gmail.com'))
WHERE (documento_norm = '51543570000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '51543570000169');
UPDATE Clientes_Eventos
SET nome_responsavel = '(79) 9 9859-8847'
WHERE (documento_norm = '51543570000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '51543570000169')
  AND (nome_responsavel IS NULL OR TRIM(nome_responsavel)='');

COMMIT;

-- Relatório
.headers on
.mode column
.print ''
.print '== Após compatibilização (v2) =='
SELECT COUNT(*) AS total_clientes,
       SUM(CASE WHEN email LIKE 'sem.email.%@importado.placeholder' THEN 1 ELSE 0 END) AS placeholders,
       SUM(CASE WHEN email IS NOT NULL AND TRIM(email)<>'' AND email NOT LIKE 'sem.email.%@importado.placeholder' THEN 1 ELSE 0 END) AS emails_reais
FROM Clientes_Eventos;

.print ''
.print '== Amostra (30) atualizados == '
SELECT nome_razao_social AS cliente, COALESCE(documento_norm,documento) AS documento, nome_responsavel AS contato, email
FROM Clientes_Eventos
WHERE email NOT LIKE 'sem.email.%@importado.placeholder'
ORDER BY cliente LIMIT 30;