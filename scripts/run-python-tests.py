"""Run Python unit tests with synthetic, isolated owner configuration."""
from pathlib import Path
import os,sys,tempfile,unittest
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='misty-tests-') as private:
 os.environ.pop('PROMINENCE_CONFIG',None)
 os.environ['PROMINENCE_OWNER_ID']='100000000000000023'
 os.environ['PROMINENCE_DATA_DIR']=private
 sys.path.insert(0,str(root/'prominence'))
 suite=unittest.defaultTestLoader.discover(str(root/'prominence'),pattern='test_*.py')
 result=unittest.TextTestRunner(verbosity=1).run(suite)
 sys.exit(0 if result.wasSuccessful() else 1)