import sqlite3
import sys

# --- Verificação de Bibliotecas ---
# O script precisa das bibliotecas 'pandas' e 'openpyxl'.
try:
    import pandas as pd
except ImportError:
    print("ERRO: A biblioteca 'pandas' é necessária, mas não está instalada.")
    print("Por favor, execute o seguinte comando para instalá-la:")
    print("sudo apt update && sudo apt install python3-pandas")
    sys.exit(1)

try:
    import openpyxl
except ImportError:
    print("ERRO: A biblioteca 'openpyxl' é necessária para criar arquivos Excel.")
    print("Por favor, execute o seguinte comando para instalá-la:")
    print("pip3 install openpyxl")
    sys.exit(1)


def export_missing_contacts_to_excel(db_path, output_excel_path):
    """
    Exporta uma lista de eventos de clientes com contatos faltando para
    um arquivo Excel (XLSX).

    Args:
        db_path (str): Caminho para o banco de dados SQLite.
        output_excel_path (str): Caminho para o arquivo Excel a ser criado.
    """
    conn = None
    try:
        conn = sqlite3.connect(db_path)

        # Query SQL para buscar os eventos de clientes com dados faltando.
        # Ela junta as tabelas Eventos e Clientes_Eventos.
        query = """
            SELECT
                e.nome_evento,
                c.documento AS 'CNPJ/CPF do Cliente',
                c.nome_responsavel AS 'Nome do Responsável'
            FROM
                Eventos e
            JOIN
                Clientes_Eventos c ON e.id_cliente = c.id
            WHERE
                c.telefone IS NULL OR c.telefone = '' OR c.email IS NULL OR c.email LIKE 'sem.email%'
            ORDER BY
                c.nome_razao_social, e.nome_evento;
        """

        print("Buscando dados no banco...")
        # Executa a query e carrega os resultados em um DataFrame do pandas
        df = pd.read_sql_query(query, conn)

        if df.empty:
            print("Nenhum evento encontrado para clientes com contatos faltando.")
            return

        print(f"{len(df)} registros encontrados. Preparando o arquivo Excel...")

        # Adiciona as colunas em branco para a equipe preencher
        df['Email (para preencher)'] = ''
        df['Telefone (para preencher)'] = ''
        
        # Garante a ordem correta das colunas
        df = df[[
            'Nome do Evento',
            'CNPJ/CPF do Cliente',
            'Nome do Responsável',
            'Email (para preencher)',
            'Telefone (para preencher)'
        ]]

        # Salva o DataFrame em um arquivo .xlsx
        df.to_excel(output_excel_path, index=False)
        
        print("\n--- SUCESSO! ---")
        print(f"Arquivo '{output_excel_path}' criado com sucesso.")
        print("Você já pode baixar o arquivo da sua VM e compartilhar com a sua equipe.")

    except sqlite3.Error as e:
        print(f"ERRO de banco de dados: {e}")
    except Exception as e:
        print(f"Ocorreu um erro inesperado: {e}")
    finally:
        if conn:
            conn.close()

# --- INSTRUÇÕES DE USO NA SUA VM ---
# 1. Suba este arquivo (export_for_team.py) para a sua VM.
# 2. Certifique-se de que a biblioteca 'openpyxl' está instalada. Se não estiver, execute:
#    pip3 install openpyxl
# 3. Execute o script no terminal com o comando:
#    python3 export_for_team.py

if __name__ == '__main__':
    DATABASE_FILE = 'sistemacipt.db'
    OUTPUT_FILE = 'tarefa_equipe.xlsx'
    
    export_missing_contacts_to_excel(DATABASE_FILE, OUTPUT_FILE)
