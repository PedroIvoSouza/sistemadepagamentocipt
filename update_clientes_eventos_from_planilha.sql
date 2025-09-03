-- Atualiza email e contato de Clientes_Eventos a partir da planilha
PRAGMA foreign_keys=OFF;
BEGIN;
-- Garante documento_norm preenchido
UPDATE Clientes_Eventos
SET documento_norm = REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','')
WHERE documento IS NOT NULL AND (documento_norm IS NULL OR documento_norm='');
UPDATE Clientes_Eventos SET email = lower('auditorios@medgrupo.com.br'), nome_responsavel = '(21) 99891-0910 / (21) 98209-3040' WHERE (documento_norm = '17654804000107' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17654804000107');
UPDATE Clientes_Eventos SET email = lower('souandreluis@gmail.com'), nome_responsavel = '(82) 98822-7274' WHERE (documento_norm = '00300771339' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '00300771339');
UPDATE Clientes_Eventos SET email = lower('albuquerquedelucena@gmail.com'), nome_responsavel = '(82) 98187-0017' WHERE (documento_norm = '14149596000109' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '14149596000109');
UPDATE Clientes_Eventos SET email = lower('christianomarinho3@gmail.com'), nome_responsavel = '(82) 9 9621-5688' WHERE (documento_norm = '37922328000175' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37922328000175');
UPDATE Clientes_Eventos SET email = lower('cepec.al@hotmail.com'), nome_responsavel = '(82) 9 8862-7871' WHERE (documento_norm = '17361388000159' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17361388000159');
UPDATE Clientes_Eventos SET email = lower('sec.lacosdosaber@gmail.com'), nome_responsavel = '(82) 9 8159-1974' WHERE (documento_norm = '35157090000103' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '35157090000103');
UPDATE Clientes_Eventos SET email = lower('producaoga.al@gmail.com'), nome_responsavel = '(82) 9 9800-9182' WHERE (documento_norm = '61024498000117' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '61024498000117');
UPDATE Clientes_Eventos SET email = lower('cleovaz@systemidiomas.com.br'), nome_responsavel = '(21) 9 8001-1166' WHERE (documento_norm = '09338997000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '09338997000169');
UPDATE Clientes_Eventos SET email = lower('carinapreis@hotmail.com'), nome_responsavel = '(82) 9 9969-0692' WHERE (documento_norm = '04489388632' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '04489388632');
UPDATE Clientes_Eventos SET email = lower('mariaduarte.mgconfeccoes@gmail.com'), nome_responsavel = '(82) 9 8188-7089' WHERE (documento_norm = '12416933000143' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '12416933000143');
UPDATE Clientes_Eventos SET email = lower('anny_gabrielle1@outlook.com'), nome_responsavel = '(82) 9956-2540 (Anny)' WHERE (documento_norm = '07800488000180' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '07800488000180');
UPDATE Clientes_Eventos SET email = lower('beatrizcavalcantecmf@gmail.com'), nome_responsavel = '(82) 99837-2830' WHERE (documento_norm = '13063572000161' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13063572000161');
UPDATE Clientes_Eventos SET email = lower('admoficinadavida@hotmail.com'), nome_responsavel = '(82) 9 9101-8892' WHERE (documento_norm = '31443184000198' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '31443184000198');
UPDATE Clientes_Eventos SET email = lower('educ.sinai@hotmail.com'), nome_responsavel = '(82) 9 8816-2316' WHERE (documento_norm = '03879039000119' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '03879039000119');
UPDATE Clientes_Eventos SET email = lower('colegiomanoelcandido23@gmail.com'), nome_responsavel = '(82) 9 8857-6852' WHERE (documento_norm = '45455018000189' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '45455018000189');
UPDATE Clientes_Eventos SET email = lower('rafinha_goncalves@hotmail.com'), nome_responsavel = '(82) 9 9309-4488' WHERE (documento_norm = '23077818000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '23077818000108');
UPDATE Clientes_Eventos SET email = lower('agendamento@multieventos.com'), nome_responsavel = '(82) 9 8831-7198' WHERE (documento_norm = '02890163000112' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '02890163000112');
UPDATE Clientes_Eventos SET email = lower('colegioiepoficial@gmail.com'), nome_responsavel = '(82) 9 9178-4460' WHERE (documento_norm = '34116804000172' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '34116804000172');
UPDATE Clientes_Eventos SET email = lower('direcao@littletown.net.br'), nome_responsavel = '(82) 9 9990-9717' WHERE (documento_norm = '32088484000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '32088484000169');
UPDATE Clientes_Eventos SET email = lower('attoartes@gmail.com'), nome_responsavel = '(82) 9 9193-7382' WHERE (documento_norm = '37992577000137' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '37992577000137');
UPDATE Clientes_Eventos SET email = lower('williams-patrik@hotmail.com'), nome_responsavel = '(82) 9 8831-7198' WHERE (documento_norm = '33191527000108' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '33191527000108');
UPDATE Clientes_Eventos SET email = lower('produtorakratendimento@gmail.com'), nome_responsavel = '(82) 9 8868-3745' WHERE (documento_norm = '13181652000111' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '13181652000111');
UPDATE Clientes_Eventos SET email = lower('casademusicavillalobos@hotmail.com'), nome_responsavel = '(82) 9 9361-3777' WHERE (documento_norm = '15629906000147' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '15629906000147');
UPDATE Clientes_Eventos SET email = lower('allegrostudiodedancaa@gmail.com'), nome_responsavel = '(82) 9 9109-2002' WHERE (documento_norm = '49453700000120' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '49453700000120');
UPDATE Clientes_Eventos SET email = lower('ecostreinamentosecursos@gmail.com'), nome_responsavel = '(79) 9 9859-8847' WHERE (documento_norm = '51543570000169' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '51543570000169');
UPDATE Clientes_Eventos SET email = lower('auditorios@medgrupo.com.br / luciene.gama@rmedcursosmedicos.com.br'), nome_responsavel = '(21) 9 9891-0910 / (21) 98209-3040' WHERE (documento_norm = '17654804000107' OR REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = '17654804000107');
-- Relatório pós-update
.headers on
.mode column
SELECT COUNT(*) AS total_clientes FROM Clientes_Eventos;
SELECT COUNT(*) AS com_email FROM Clientes_Eventos WHERE email IS NOT NULL AND TRIM(email) <> '';
SELECT COUNT(*) AS com_contato FROM Clientes_Eventos WHERE nome_responsavel IS NOT NULL AND TRIM(nome_responsavel) <> '';
COMMIT;