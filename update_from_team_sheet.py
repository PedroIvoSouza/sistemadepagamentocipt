import sqlite3
import sys
import re

# --- Verificação de Bibliotecas ---
try:
    import pandas as pd
except ImportError:
    print("ERRO: A biblioteca 'pandas' é necessária, mas não está instalada.")
    print("Por favor, execute o seguinte comando para instalá-la:")
    print("sudo apt update && sudo apt install python3-pandas")
    sys.exit(1)


def update_contacts_from_filled_csv(db_path, csv_path):
    """
    Atualiza os contactos (e-mail e telefone) na tabela Clientes_Eventos
    a partir de um ficheiro CSV preenchido pela equipa.

    Args:
        db_path (str): Caminho para o banco de dados SQLite.
        csv_path (str): Caminho para o ficheiro CSV com os dados preenchidos.
    """
    conn = None
    try:
        print(f"A ler o ficheiro CSV: '{csv_path}'...")
        # Lê o CSV, tratando todas as colunas como texto para evitar erros
        df = pd.read_csv(csv_path, dtype=str).fillna('')
        df.columns = df.columns.str.strip()

        # Garante que as colunas necessárias existem
        required_columns = ['CNPJ/CPF do Cliente', 'Email (para preencher)', 'Telefone (para preencher)']
        for col in required_columns:
            if col not in df.columns:
                raise KeyError(f"A coluna '{col}' não foi encontrada no ficheiro CSV.")

        # Remove duplicados para processar cada cliente apenas uma vez
        unique_clients_df = df.drop_duplicates(subset=['CNPJ/CPF do Cliente'])
        
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        updated_count = 0
        not_found_list = []

        print(f"A processar {len(unique_clients_df)} clientes únicos do ficheiro...")

        for index, row in unique_clients_df.iterrows():
            doc_raw = row['CNPJ/CPF do Cliente']
            email_new = row['Email (para preencher)'].strip()
            phone_new_raw = row['Telefone (para preencher)']

            # Ignora linhas sem documento
            if not doc_raw:
                continue

            # Normaliza os dados
            doc_norm = re.sub(r'\D', '', doc_raw)
            phone_norm = re.sub(r'\D', '', phone_new_raw)

            # Só executa a atualização se houver um e-mail ou telefone para adicionar
            if email_new or phone_norm:
                cursor.execute("""
                    UPDATE Clientes_Eventos
                    SET email = ?, telefone = ?
                    WHERE documento_norm = ?
                """, (email_new, phone_norm, doc_norm))

                if cursor.rowcount > 0:
                    updated_count += 1
                else:
                    not_found_list.append(doc_raw)
        
        conn.commit()
        
        print("\n--- SUCESSO! ---")
        print(f"Processo concluído. {updated_count} clientes foram atualizados na base de dados.")
        
        if not_found_list:
            print("\nOs seguintes clientes do CSV não foram encontrados na base de dados (verifique o CNPJ/CPF):")
            for doc in not_found_list:
                print(f"- {doc}")

    except FileNotFoundError:
        print(f"ERRO: O ficheiro '{csv_path}' não foi encontrado.")
    except KeyError as e:
        print(f"ERRO: {e}")
    except sqlite3.Error as e:
        print(f"ERRO de base de dados: {e}")
    except Exception as e:
        print(f"Ocorreu um erro inesperado: {e}")
    finally:
        if conn:
            conn.close()

# --- INSTRUÇÕES DE USO NA SUA VM ---
# 1. Faça backup da sua base de dados por segurança:
#    cp sistemacipt.db sistemacipt.db.bkp_before_final_update
# 2. Suba este script (update_from_team_sheet.py) para a sua VM.
# 3. Suba o ficheiro CSV preenchido ('Dados para Preenchimento - Eventos - Sheet1.csv') para a mesma pasta.
# 4. Execute o script no terminal:
#    python3 update_from_team_sheet.py

if __name__ == '__main__':
    DATABASE_FILE = 'sistemacipt.db'
    CSV_FILE = 'Dados para Preenchimento - Eventos - Sheet1.csv'
    
    update_contacts_from_filled_csv(DATABASE_FILE, CSV_FILE)
