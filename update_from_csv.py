import sqlite3
import pandas as pd
import sys

def update_database_from_csv(db_path, csv_path):
    """
    Atualiza a tabela Clientes_Eventos de um banco de dados SQLite com
    informações de um arquivo CSV normalizado.

    A correspondência é feita usando o campo 'documento_norm'.

    Args:
        db_path (str): Caminho para o banco de dados SQLite.
        csv_path (str): Caminho para o arquivo CSV com os dados.
    """
    try:
        # Lê o arquivo CSV normalizado
        df = pd.read_csv(csv_path, dtype=str).fillna('')
    except FileNotFoundError:
        print(f"ERRO: O arquivo '{csv_path}' não foi encontrado.")
        print("Certifique-se de que o script e o arquivo CSV estão na mesma pasta.")
        sys.exit(1) # Encerra o script se o CSV não for encontrado

    # Conecta ao banco de dados
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        updated_count = 0
        not_found_list = []

        print("Iniciando a atualização do banco de dados...")

        # Itera sobre cada linha do DataFrame do CSV
        for index, row in df.iterrows():
            doc_norm = row['CNPJ/CPF']
            email = row['Email']
            telefone = row['Telefone']
            responsavel = row['Responsável']
            
            # Pula linhas que não tenham um CNPJ/CPF válido
            if not doc_norm:
                continue

            # Monta e executa a query de UPDATE
            cursor.execute("""
                UPDATE Clientes_Eventos
                SET
                    email = ?,
                    telefone = ?,
                    nome_responsavel = ?
                WHERE
                    documento_norm = ?
            """, (email, telefone, responsavel, doc_norm))

            # Verifica se alguma linha foi realmente alterada
            if cursor.rowcount > 0:
                updated_count += 1
            else:
                # Se rowcount for 0, ninguém com aquele documento foi encontrado
                not_found_list.append(f"{row['NOME/RAZAO SOCIAL']} (Documento: {doc_norm})")

        # Comita as alterações para salvá-las no banco
        conn.commit()
        print("Atualização concluída.")

        # --- Relatório Final ---
        print("\n--- Relatório de Atualização ---")
        print(f"Clientes atualizados com sucesso: {updated_count}")

        if not_found_list:
            print(f"\nClientes do CSV não encontrados no banco de dados ({len(not_found_list)}):")
            for item in not_found_list:
                print(f"- {item}")
        else:
            print("\nTodos os clientes do CSV foram encontrados e atualizados no banco de dados!")

    except sqlite3.Error as e:
        print(f"ERRO de banco de dados: {e}")
        if conn:
            conn.rollback() # Desfaz qualquer alteração se ocorrer um erro
    except Exception as e:
        print(f"Ocorreu um erro inesperado: {e}")
    finally:
        if conn:
            conn.close() # Garante que a conexão seja sempre fechada

# --- INSTRUÇÕES DE USO NA SUA VM ---
# 1. Faça um backup do seu banco de dados por segurança:
#    cp sistemacipt.db sistemacipt.db.bkp
#
# 2. Suba este arquivo (update_from_csv.py) e o arquivo 'clientes_normalizados.csv'
#    para a mesma pasta onde está o seu banco 'sistemacipt.db'.
#
# 3. Execute o script no terminal com o comando:
#    python3 update_from_csv.py

if __name__ == '__main__':
    # Define os nomes dos arquivos. Altere se necessário.
    DATABASE_FILE = 'sistemacipt.db'
    CSV_NORMALIZED_FILE = 'clientes_normalizados.csv'
    
    update_database_from_csv(DATABASE_FILE, CSV_NORMALIZED_FILE)

